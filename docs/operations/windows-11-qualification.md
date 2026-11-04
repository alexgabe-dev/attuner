# Standalone Windows 11 qualification

No GitHub runner, Rust compiler, Node installation or administrator shell is required for this bundle. It contains a native qualification driver, Windows handle-safety tests, a synthetic process-interruption recovery harness, prerequisite probes, protocol tests, Credential Manager tests and a portable debug desktop app. Every filesystem test mints its own synthetic temporary directory. Nothing searches for or opens a WoW installation.

Windows filesystem apply is deliberately disabled. Passing these probes is **prerequisite evidence**, not completed Windows recovery qualification. Do not power-cycle your physical PC for this stage.

## Download and run

1. In the Attuner GitHub repository, open **Actions → Attuner verification**, choose a successful run on `phase4-beta-readiness`, and download **attuner-windows-qualification**. Check its source commit against `manifest.json` after extracting the ZIP into a new local folder, for example `Documents\AttunerQualification`. These unsigned checksums detect incomplete/changed files; they do not authenticate a ZIP obtained outside the trusted repository/run.
2. Open a normal PowerShell window in the extracted folder. The native driver verifies every bundled file against the manifest before starting any tests. Run:

```powershell
.\Qualify-Windows.exe
```

The native driver changes no system or process execution policy. It verifies every bundled file, retains no-write/no-delete handles while tests run and creates a new `attuner-windows-results-*` directory under your own temporary directory. The exact results path is printed; it contains `report.json` and five individual logs. Tests and their descendants are contained in an owned Windows Job Object, including abnormal termination. No existing files are deleted. Credential tests create/rotate/remove only random `app.attuner.desktop.tests` entries. The PowerShell wrapper is optional and should be used only if your existing policy permits it; do not lower execution policy to run qualification.

The schema-4 report records Windows build/product type, process/native architecture, elevation state, source commit, five test executable exit codes/timeouts and process-containment status. `synthetic_native_recovery_passed` means those tests passed; complete engine application/recovery, power-loss durability, signing and desktop visual review remain separate unqualified gates. Recovery executable success describes the isolated one-file native experiment, not the complete engine's SQLite transaction. A failed containment check makes the aggregate report fail.

The handle suite exercises pinned-parent traversal and identity, no-clobber renames, junction/hard-link rejection, case aliases, concurrent write/delete interference and read-only/locked entries. NTFS can add hard links while a handle is pinned; checks require detection/refusal, not a false claim that sharing flags prevent it. The recovery executable terminates its own synthetic child processes at seven application and four rollback boundaries, checks byte preservation/retry, corrupt/missing backup and journal rejection, retained partial record stages, simulated disk-full short writes, verification failure, concurrent edits/creations and locked-file interference. It never fills your disk, kills other applications, changes permissions to make an operation succeed, changes Defender or reboots the machine. The one ignored child entry point is invoked by its parent matrices; do not run `--ignored` manually. ARM64 running the x64 bundle is compatibility evidence only; native ARM64 qualification remains separate.

## Desktop review

After the scripts pass, launch the portable app:

```powershell
Start-Process .\Attuner.exe
```

It is an unsigned development build, not an installer or production release. If Windows/enterprise policy blocks an executable, report the blocker rather than bypassing SmartScreen, execution policy, Defender or machine security settings. Verify the trusted repository/run and checksums; checksums alone do not establish publisher identity. The app uses WebView2. Windows 11 normally includes that runtime; a missing-runtime message (including a missing Microsoft C++ runtime) is a prerequisite to report, not permission for the bundle to install system software. See Microsoft's [WebView2 distribution guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution).

Record screenshots at 100%, 125% and 150% display scaling: window controls, sidebar, profile menu, tables, dialogs, focus rings and narrow-window behavior. Use keyboard navigation and check long device/file names. Confirm the Windows filesystem qualification gate is visible and fixture/apply actions are disabled where unsupported. Do not select a game directory; no installation picker should exist.

The connection screen must explain that Windows file operations await durability qualification. After enrollment, remote devices, revisions, activity, comparisons and proposals are real; local fixture/apply actions remain disabled. Use a synthetic development account/profile only. Do not paste credentials into logs or the report.

For an optional connected check against an already configured private SSH host running the loopback development services, open another normal PowerShell window and keep this tunnel running:

```powershell
ssh -N -L 4318:127.0.0.1:4318 <your-mac-user>@<your-private-mac-host>
```

Do not enable SSH or change firewall settings solely through these scripts. If an existing private connection is unavailable, complete the standalone probes and offline UI review first. The macOS service launch commands are in [Phase 3 development](phase-3-development.md). Use `https://127.0.0.1:4318` on the Windows PC. Copy only the public `.runtime/dashboard-ca.pem`, verify its SHA-256 against the macOS copy, and paste that public certificate into Attuner’s custom CA field:

```powershell
Get-FileHash .\dashboard-ca.pem -Algorithm SHA256
```

Create a synthetic profile in the HTTPS web dashboard, choose **Connect device** in the portable app, approve only that profile’s permissions in the browser, and return to Attuner. Verify Credential Manager reconnect using the same binary, remote navigation/filters, immutable revision comparison, conflict proposal review, and revocation. Any browser certificate warning requires a deliberate local owner decision; the qualification scripts do not bypass it or install a trusted root. Never enable Windows file application to complete a UI check.

## Evidence to return

Return `report.json`, the five test logs, screenshots and any reproduction steps. Review those files before sharing; they contain no account tokens, but an operating-system error can include your local temporary path. Keep Defender in its normal enabled configuration and report quarantine/Controlled Folder Access/sharing failures with their timestamps. Do not add exclusions or retry with elevation to manufacture a pass. Report missing WebView2, application launch failure, antivirus interference or unexpected prompts rather than changing system policy.

The remaining write/apply qualification requires a reviewed Windows-native journal/durability implementation, its complete interruption/recovery suite and controlled retained-disk reset testing. A physical-PC reboot is not a substitute for a controlled fault environment. Until that gate is closed, Attuner must continue to refuse Windows filesystem application.
