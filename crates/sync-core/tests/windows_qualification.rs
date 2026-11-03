//! Independent Windows-native probes. These do not enable the engine's apply gate.
#![cfg(windows)]
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
    process::Command,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, GetFileInformationByHandle, GetVolumeInformationByHandleW,
    MOVEFILE_WRITE_THROUGH, MoveFileExW,
};
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
fn information(file: &File) -> BY_HANDLE_FILE_INFORMATION {
    let mut value = std::mem::MaybeUninit::zeroed();
    // SAFETY: live owned handle and writable correctly sized result.
    assert_ne!(
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), value.as_mut_ptr()) },
        0,
        "{}",
        std::io::Error::last_os_error()
    );
    unsafe { value.assume_init() }
}
fn no_follow(path: &Path) -> File {
    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .unwrap()
}
fn move_new(source: &Path, destination: &Path) -> bool {
    // SAFETY: both paths are owned synthetic, nul-terminated buffers. No replace flag.
    unsafe {
        MoveFileExW(
            wide(source).as_ptr(),
            wide(destination).as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        ) != 0
    }
}
#[test]
fn ntfs_handles_identity_no_clobber_and_sharing_are_independently_probed() {
    let directory = tempfile::Builder::new()
        .prefix("attuner-windows-probe-")
        .tempdir()
        .unwrap();
    let root = no_follow(directory.path());
    let mut filesystem = [0u16; 32];
    // SAFETY: live directory handle; only the provided filesystem name buffer is written.
    assert_ne!(
        unsafe {
            GetVolumeInformationByHandleW(
                root.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                filesystem.as_mut_ptr(),
                filesystem.len() as u32,
            )
        },
        0
    );
    let end = filesystem
        .iter()
        .position(|c| *c == 0)
        .unwrap_or(filesystem.len());
    assert_eq!(
        String::from_utf16_lossy(&filesystem[..end]),
        "NTFS",
        "Only local NTFS is a qualification target."
    );
    let source = directory.path().join("staging.bin");
    let destination = directory.path().join("installed.bin");
    let bytes = b"synthetic Windows original bytes\0\r\n";
    let mut file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(&source)
        .unwrap();
    file.write_all(bytes).unwrap();
    file.sync_all().unwrap();
    let before = information(&file);
    drop(file);
    fs::write(&destination, b"unrelated concurrent bytes").unwrap();
    assert!(!move_new(&source, &destination));
    assert_eq!(
        fs::read(&destination).unwrap(),
        b"unrelated concurrent bytes"
    );
    fs::remove_file(&destination).unwrap();
    let locked = OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&source)
        .unwrap();
    assert!(!move_new(&source, &destination));
    drop(locked);
    assert!(move_new(&source, &destination));
    let after = information(&no_follow(&destination));
    assert_eq!(
        (
            before.dwVolumeSerialNumber,
            before.nFileIndexHigh,
            before.nFileIndexLow
        ),
        (
            after.dwVolumeSerialNumber,
            after.nFileIndexHigh,
            after.nFileIndexLow
        )
    );
    assert_eq!(fs::read(&destination).unwrap(), bytes);
    let hardlink = directory.path().join("hardlink.bin");
    fs::hard_link(&destination, &hardlink).unwrap();
    assert_eq!(information(&no_follow(&destination)).nNumberOfLinks, 2);
}
#[test]
fn junctions_are_visible_without_following_the_target() {
    let directory = tempfile::Builder::new()
        .prefix("attuner-junction-probe-")
        .tempdir()
        .unwrap();
    let target = directory.path().join("target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("original.bin"), b"untouched fixture").unwrap();
    let junction = directory.path().join("junction");
    let result = Command::new("cmd")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(&junction)
        .arg(&target)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "Synthetic junction creation must work for qualification."
    );
    let handle = no_follow(&junction);
    assert_ne!(
        information(&handle).dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT,
        0
    );
    drop(handle);
    fs::remove_dir(&junction).unwrap();
    assert_eq!(
        fs::read(target.join("original.bin")).unwrap(),
        b"untouched fixture"
    );
}
