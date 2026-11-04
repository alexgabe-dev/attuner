//! Standalone synthetic qualification driver. No script execution-policy changes.
#[cfg(windows)]
mod driver {
    use serde::Deserialize;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::{
        collections::BTreeSet,
        fs::{File, OpenOptions},
        io::{Read, Write},
        mem::size_of,
        os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
        path::{Path, PathBuf},
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    use windows_sys::{
        Wdk::System::SystemServices::RtlGetVersion,
        Win32::{
            Foundation::{CloseHandle, HANDLE},
            Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation},
            Storage::FileSystem::{
                BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, GetFileInformationByHandle,
            },
            System::{
                JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
                    QueryInformationJobObject, SetInformationJobObject,
                },
                SystemInformation::{GetNativeSystemInfo, OSVERSIONINFOEXW, SYSTEM_INFO},
                Threading::{GetCurrentProcess, OpenProcessToken},
            },
        },
    };
    type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
    /// The runner enters its own unnamed job before spawning any tests. Children
    /// inherit containment with no spawn/assignment race. On abnormal runner exit
    /// Windows closes this handle and terminates only its test descendants.
    pub struct TestJob(HANDLE);
    impl TestJob {
        pub fn new() -> Result<Self> {
            // SAFETY: no security descriptor/name; returned handle is owned.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: correct sized initialized structure, live owned job/current process.
            let ok = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 || unsafe { AssignProcessToJobObject(handle, GetCurrentProcess()) } == 0 {
                let error = std::io::Error::last_os_error();
                unsafe {
                    CloseHandle(handle);
                }
                return Err(error.into());
            }
            Ok(Self(handle))
        }
        pub fn finish(&self) -> Result<()> {
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            // SAFETY: live handle and matching writable information buffer.
            if unsafe {
                QueryInformationJobObject(
                    self.0,
                    JobObjectBasicAccountingInformation,
                    (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            if accounting.ActiveProcesses != 1 {
                return Err(
                    "Test descendants remained active; they will be terminated with the runner"
                        .into(),
                );
            }
            let limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            // With no descendants left, clear only this owned job's close action
            // so normal shutdown does not terminate the runner before it exits.
            if unsafe {
                SetInformationJobObject(
                    self.0,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            unsafe {
                CloseHandle(self.0);
            }
            Ok(())
        }
    }
    const TESTS: [&str; 5] = [
        "handle-safety.exe",
        "native-recovery.exe",
        "ntfs-probes.exe",
        "protocol-tests.exe",
        "credential-tests.exe",
    ];
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Manifest {
        schema_version: u8,
        source_commit: String,
        target: String,
        rust: String,
        files: Vec<Entry>,
        filesystem_apply_enabled: bool,
        scope: String,
        signed: bool,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Entry {
        name: String,
        sha256: String,
    }
    fn info(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION> {
        let mut value = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: live owned handle, correctly sized writable result.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut value) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if value.dwFileAttributes & (0x400 | 0x10) != 0 || value.nNumberOfLinks != 1 {
            return Err("Unsafe bundle entry".into());
        }
        Ok(value)
    }
    fn hash(path: &Path) -> Result<(String, File)> {
        let mut file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let before = info(&file)?;
        if file.metadata()?.len() > 256 * 1024 * 1024 {
            return Err("Oversized bundle entry".into());
        }
        let mut hash = Sha256::new();
        let mut buffer = [0; 65536];
        let mut size = 0;
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            size += count;
            if size > 256 * 1024 * 1024 {
                return Err("Bundle grew".into());
            }
            hash.update(&buffer[..count]);
        }
        let after = info(&file)?;
        if size as u64 != (u64::from(before.nFileSizeHigh) << 32 | u64::from(before.nFileSizeLow)) {
            return Err("Bundle length changed".into());
        }
        if (
            before.dwVolumeSerialNumber,
            before.nFileIndexHigh,
            before.nFileIndexLow,
            before.nFileSizeHigh,
            before.nFileSizeLow,
            before.ftLastWriteTime.dwHighDateTime,
            before.ftLastWriteTime.dwLowDateTime,
        ) != (
            after.dwVolumeSerialNumber,
            after.nFileIndexHigh,
            after.nFileIndexLow,
            after.nFileSizeHigh,
            after.nFileSizeLow,
            after.ftLastWriteTime.dwHighDateTime,
            after.ftLastWriteTime.dwLowDateTime,
        ) {
            return Err("Bundle changed".into());
        }
        Ok((format!("{:x}", hash.finalize()), file))
    }
    fn pin_directories(root: &Path) -> Result<Vec<File>> {
        let mut pinned = Vec::new();
        for directory in root.ancestors().collect::<Vec<_>>().into_iter().rev() {
            let file = OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
                .open(directory)?;
            let mut value = BY_HANDLE_FILE_INFORMATION::default();
            // SAFETY: live directory handle and correctly sized writable result.
            if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut value) } == 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            if value.dwFileAttributes & 0x400 != 0 || value.dwFileAttributes & 0x10 == 0 {
                return Err("Bundle directory is a reparse point or not a directory".into());
            }
            pinned.push(file);
        }
        Ok(pinned)
    }
    fn system() -> Result<(OSVERSIONINFOEXW, bool, u16)> {
        let mut version = OSVERSIONINFOEXW {
            dwOSVersionInfoSize: size_of::<OSVERSIONINFOEXW>() as u32,
            ..Default::default()
        };
        // SAFETY: extended version structure advertises its actual size. RtlGetVersion
        // accepts both layouts and writes only the supplied initialized allocation.
        if unsafe { RtlGetVersion((&mut version as *mut OSVERSIONINFOEXW).cast()) } < 0 {
            return Err("Cannot verify Windows version".into());
        }
        let mut token = std::ptr::null_mut();
        // SAFETY: current-process pseudo-handle, writable returned owned token handle.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut length = 0;
        // SAFETY: matching token class/structure and live token handle. Close on all paths.
        let ok = unsafe {
            GetTokenInformation(
                token,
                TokenElevation,
                (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut length,
            )
        };
        let error = std::io::Error::last_os_error();
        unsafe {
            CloseHandle(token);
        }
        if ok == 0 {
            return Err(error.into());
        }
        let mut native = SYSTEM_INFO::default();
        // SAFETY: correctly sized initialized output; only reading the documented
        // architecture union member after GetNativeSystemInfo initialized it.
        unsafe {
            GetNativeSystemInfo(&mut native);
        }
        let architecture = unsafe { native.Anonymous.Anonymous.wProcessorArchitecture };
        Ok((version, elevation.TokenIsElevated != 0, architecture))
    }
    pub struct Outcome {
        passed: bool,
        results: PathBuf,
        report: serde_json::Value,
    }
    pub fn run() -> Result<Outcome> {
        let args: Vec<_> = std::env::args().skip(1).collect();
        let allow_server = args == ["--allow-server"];
        if !args.is_empty() && !allow_server {
            return Err("Usage: Qualify-Windows.exe [--allow-server (CI only)]".into());
        }
        let (version, elevated, native_architecture) = system()?;
        let windows11 = version.dwMajorVersion == 10
            && version.dwBuildNumber >= 22000
            && version.wProductType == 1;
        if !allow_server && (!windows11 || elevated) {
            return Err("Use a normal, non-administrator terminal on Windows 11. No policy/security changes are needed.".into());
        }
        let executable = std::env::current_exe()?;
        let root = executable.parent().ok_or("Missing bundle directory")?;
        // Pin ancestors before validating executable names: retaining just file
        // handles would still allow a parent directory to be replaced at spawn.
        let _directories = pin_directories(root)?;
        let manifest_path = root.join("manifest.json");
        let (_, mut manifest_file) = hash(&manifest_path)?;
        use std::io::{Seek, SeekFrom};
        manifest_file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        manifest_file.take(65537).read_to_end(&mut bytes)?;
        if bytes.len() > 65536 {
            return Err("Manifest size limit".into());
        }
        let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
        let manifest: Manifest = serde_json::from_slice(bytes)?;
        if manifest.schema_version != 4
            || manifest.filesystem_apply_enabled
            || manifest.scope != "synthetic_native_recovery"
            || manifest.signed
            || manifest.target != "x86_64-pc-windows-msvc"
            || manifest.rust.len() > 200
            || manifest.source_commit.len() != 40
            || !manifest
                .source_commit
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("Unsupported qualification bundle".into());
        }
        let expected: BTreeSet<_> = TESTS
            .into_iter()
            .chain([
                "Attuner.exe",
                "Qualify-Windows.exe",
                "Qualify-Windows.ps1",
                "README.md",
            ])
            .collect();
        let actual: BTreeSet<_> = manifest.files.iter().map(|e| e.name.as_str()).collect();
        if actual != expected || actual.len() != manifest.files.len() {
            return Err("Incomplete/duplicate bundle inventory".into());
        }
        // Retain no-write/no-delete handles through all child execution, rather
        // than validating names and closing the files before spawning them.
        let mut pinned = Vec::new();
        for entry in &manifest.files {
            if entry.sha256.len() != 64
                || !entry
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            {
                return Err("Invalid checksum".into());
            }
            let (digest, file) = hash(&root.join(&entry.name))?;
            if digest != entry.sha256 {
                return Err(format!("Bundle checksum failed: {}", entry.name).into());
            }
            pinned.push(file);
        }
        let results = tempfile::Builder::new()
            .prefix("attuner-windows-results-")
            .tempdir()?
            .keep();
        let mut tests = Vec::new();
        let mut failed = false;
        for test in TESTS {
            println!("Checking {test} (synthetic fixtures only)...");
            let log = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(results.join(format!("{test}.log")))?;
            let mut child = Command::new(root.join(test))
                .arg("--test-threads=1")
                .stdin(Stdio::null())
                .stdout(Stdio::from(log.try_clone()?))
                .stderr(Stdio::from(log))
                .spawn()?;
            let start = Instant::now();
            let mut timed_out = false;
            let status = loop {
                if let Some(status) = child.try_wait()? {
                    break status;
                }
                if start.elapsed() > Duration::from_secs(180) {
                    timed_out = true;
                    child.kill()?;
                    break child.wait()?;
                }
                std::thread::sleep(Duration::from_millis(50));
            };
            let passed = status.success() && !timed_out;
            failed |= !passed;
            tests.push(json!({ "executable": test, "exitCode": status.code(), "passed": passed, "timedOut": timed_out }));
        }
        let report = json!({ "schemaVersion": 4, "sourceCommit": manifest.source_commit,
            "os": { "major": version.dwMajorVersion, "minor": version.dwMinorVersion, "build": version.dwBuildNumber, "productType": version.wProductType },
            "architecture": std::env::consts::ARCH, "nativeArchitecture": native_architecture,
            "nativeTargetMatched": native_architecture == 9, "bundleTarget": manifest.target,
            "windows11": windows11, "elevated": elevated, "allowServer": allow_server,
            "tests": tests, "qualification": if failed { "failed" } else { "synthetic_native_recovery_passed" },
            "filesystemApplyEnabled": false, "applicationRecoveryQualified": false, "powerLossQualified": false,
            "desktopVisualReview": "pending_manual_review", "signedDistributionQualified": false,
            "realInstallationsAccessed": false, "defenderConfigurationChanged": false,
            "executionPolicyChanged": false });
        drop(pinned);
        Ok(Outcome {
            passed: !failed,
            results,
            report,
        })
    }
    pub fn publish(mut outcome: Outcome, contained: bool) -> Result<bool> {
        outcome.report["processContainmentVerified"] = json!(contained);
        if !contained {
            outcome.report["qualification"] = json!("failed");
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(outcome.results.join("report.json"))?;
        output.write_all(serde_json::to_string_pretty(&outcome.report)?.as_bytes())?;
        output.sync_all()?;
        println!("Results: {}", outcome.results.display());
        println!(
            "Windows apply, full-engine recovery, power-loss durability and signed distribution remain unqualified."
        );
        Ok(outcome.passed && contained)
    }
}

#[cfg(windows)]
fn main() {
    let job = match driver::TestJob::new() {
        Ok(job) => job,
        Err(error) => {
            eprintln!("Cannot contain test processes safely: {error}");
            std::process::exit(2);
        }
    };
    let outcome = driver::run();
    let containment = job.finish();
    let code = match outcome {
        Ok(outcome) => match driver::publish(outcome, containment.is_ok()) {
            Ok(true) => 0,
            Ok(false) => 1,
            Err(error) => {
                eprintln!("Cannot write qualification report: {error}");
                2
            }
        },
        Err(error) => {
            eprintln!("Qualification stopped: {error}");
            2
        }
    };
    if let Err(error) = containment {
        eprintln!("Qualification containment: {error}");
        // Do not drop/close a self-containing job early. ExitProcess closes the
        // owned handle at process teardown, terminating any retained descendants.
        std::process::exit(3);
    }
    std::process::exit(code);
}
#[cfg(not(windows))]
fn main() {
    eprintln!("This standalone qualification driver runs only on Windows.");
    std::process::exit(2);
}
