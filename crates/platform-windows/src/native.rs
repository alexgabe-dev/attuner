use crate::{Component, Error, Result};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    mem::{offset_of, size_of},
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::Path,
    ptr,
    sync::Arc,
};
use windows_sys::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
            FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION, FILE_SYNCHRONOUS_IO_NONALERT,
            FILE_WRITE_THROUGH, FileRenameInformation, NtCreateFile, NtSetInformationFile,
        },
    },
    Win32::{
        Foundation::{OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError, UNICODE_STRING},
        Storage::FileSystem::{
            DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_READONLY,
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_CASE_SENSITIVE_INFO, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_ID_INFO,
            FILE_NAME_INFO, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FileCaseSensitiveInfo,
            FileIdInfo, FileNameInfo, GetDriveTypeW, GetFileInformationByHandle,
            GetFileInformationByHandleEx, GetFinalPathNameByHandleW, GetVolumeInformationByHandleW,
            SYNCHRONIZE,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    pub volume: u64,
    pub file_id: [u8; 16],
}

/// A retained parent chain; ancestors cannot be renamed/deleted through ordinary
/// concurrent handles while descendants remain open. No raw handle is exported.
#[derive(Clone)]
pub struct Directory(Arc<DirectoryInner>);
struct DirectoryInner {
    file: File,
    identity: Identity,
    _parent: Option<Directory>,
}

pub struct PinnedFile {
    file: File,
    parent: Directory,
    name: Component,
    identity: Identity,
    writable: bool,
}

/// Only constructor for an ambient root. Never accepts a caller-supplied path.
pub struct SyntheticWorkspace {
    // Drop handles before TempDir attempts cleanup.
    root: Directory,
    temporary: tempfile::TempDir,
}

impl SyntheticWorkspace {
    pub fn create() -> Result<Self> {
        let temporary = tempfile::Builder::new()
            .prefix("attuner-handle-lab-")
            .tempdir()?;
        let file = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES | SYNCHRONIZE)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(temporary.path())
            .map_err(io_error)?;
        local_ntfs(&file)?;
        let identity = check(&file, true, None)?;
        let root = Directory(Arc::new(DirectoryInner {
            file,
            identity,
            _parent: None,
        }));
        Ok(Self { root, temporary })
    }

    pub fn root(&self) -> Directory {
        self.root.clone()
    }

    /// For qualification interference fixtures only, never a real installation.
    pub fn fixture_path(&self) -> &Path {
        self.temporary.path()
    }
}

impl Directory {
    /// Child-test handoff only; never compiled into the desktop/production library.
    #[cfg(test)]
    pub(crate) fn attach_test_root(path: &Path, expected: Identity) -> Result<Self> {
        if path.parent().ok_or(Error::Changed)?.canonicalize()?
            != std::env::temp_dir().canonicalize()?
            || !path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("attuner-handle-lab-"))
        {
            return Err(Error::Unsafe("not a minted qualification root"));
        }
        let file = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES | SYNCHRONIZE)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(io_error)?;
        local_ntfs(&file)?;
        let identity = check(&file, true, Some(expected.volume))?;
        if identity != expected {
            return Err(Error::Changed);
        }
        Ok(Self(Arc::new(DirectoryInner {
            file,
            identity,
            _parent: None,
        })))
    }

    pub fn identity(&self) -> Identity {
        self.0.identity
    }

    pub fn create_dir(&self, name: &Component) -> Result<Self> {
        self.directory(name, true)
    }

    pub fn open_dir(&self, name: &Component) -> Result<Self> {
        self.directory(name, false)
    }

    fn directory(&self, name: &Component, create: bool) -> Result<Self> {
        self.recheck()?;
        let file = relative_open(
            self,
            name,
            FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            if create { FILE_CREATE } else { FILE_OPEN },
            if create { FILE_DIRECTORY_FILE } else { 0 },
        )?;
        let identity = check(&file, true, Some(self.identity().volume))?;
        exact_name(&file, name)?;
        Ok(Self(Arc::new(DirectoryInner {
            file,
            identity,
            _parent: Some(self.clone()),
        })))
    }

    pub fn create_file(&self, name: &Component) -> Result<PinnedFile> {
        self.file(name, true)
    }

    /// Opens a preimage with DELETE access, denying other write/delete handles.
    /// Read-only and locked preimages fail before any mutation.
    pub fn open_file(&self, name: &Component) -> Result<PinnedFile> {
        self.file(name, false)
    }

    fn file(&self, name: &Component, create: bool) -> Result<PinnedFile> {
        self.recheck()?;
        let access = FILE_GENERIC_READ | DELETE | if create { FILE_GENERIC_WRITE } else { 0 };
        let file = relative_open(
            self,
            name,
            access,
            if create { FILE_CREATE } else { FILE_OPEN },
            FILE_NON_DIRECTORY_FILE | if create { FILE_WRITE_THROUGH } else { 0 },
        )?;
        let identity = check(&file, false, Some(self.identity().volume))?;
        exact_name(&file, name)?;
        Ok(PinnedFile {
            file,
            parent: self.clone(),
            name: name.clone(),
            identity,
            writable: create,
        })
    }

    fn recheck(&self) -> Result<()> {
        if check(&self.0.file, true, Some(self.identity().volume))? != self.identity() {
            return Err(Error::Changed);
        }
        Ok(())
    }
}

impl PinnedFile {
    pub fn identity(&self) -> Identity {
        self.identity
    }

    /// Bounded caller buffer; no whole-file allocation or truncation.
    pub fn read(&mut self, buffer: &mut [u8]) -> Result<usize> {
        self.recheck()?;
        let count = self.file.read(buffer).map_err(io_error)?;
        self.recheck()?;
        Ok(count)
    }

    pub fn rewind(&mut self) -> Result<()> {
        self.recheck()?;
        self.file.seek(SeekFrom::Start(0)).map_err(io_error)?;
        Ok(())
    }

    pub fn write_all(&mut self, bytes: &[u8]) -> Result<()> {
        if !self.writable {
            return Err(Error::Unsafe("preimage is not writable"));
        }
        self.recheck()?;
        self.file.write_all(bytes).map_err(io_error)?;
        self.recheck()
    }

    /// File flush, deliberately not a directory/transaction durability claim.
    pub fn flush_file(&self) -> Result<()> {
        if !self.writable {
            return Err(Error::Unsafe("flush requires write access"));
        }
        self.recheck()?;
        self.file.sync_all().map_err(io_error)?;
        self.recheck()
    }

    /// Handle-based same-volume rename. Never replaces an existing destination.
    /// Source handle stays alive, preserving identity through the transition.
    pub fn rename_new(&mut self, destination: &Directory, name: &Component) -> Result<()> {
        self.recheck()?;
        destination.recheck()?;
        if destination.identity().volume != self.identity.volume {
            return Err(Error::Unsafe("cross-volume rename"));
        }
        let encoded: Vec<u16> = name.as_str().encode_utf16().collect();
        let bytes = offset_of!(FILE_RENAME_INFORMATION, FileName) + encoded.len() * 2;
        // u64 storage gives the native structure correct alignment on both targets.
        let mut storage = vec![0u64; bytes.div_ceil(8)];
        let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
        let mut status = IO_STATUS_BLOCK::default();
        // SAFETY: aligned, zeroed allocation covers fixed fields and the bounded
        // flexible UTF-16 tail. Live handles and buffers outlive synchronous call.
        let result = unsafe {
            (*info).Anonymous.ReplaceIfExists = false;
            (*info).RootDirectory = destination.0.file.as_raw_handle();
            (*info).FileNameLength = (encoded.len() * 2) as u32;
            ptr::copy_nonoverlapping(
                encoded.as_ptr(),
                ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
                encoded.len(),
            );
            NtSetInformationFile(
                self.file.as_raw_handle(),
                &mut status,
                info.cast(),
                bytes as u32,
                FileRenameInformation,
            )
        };
        nt_result(result)?;
        // Update retained parent first: if post-rename verification fails, callers
        // receive an error but the owned file remains pinned at its destination.
        self.parent = destination.clone();
        self.name = name.clone();
        self.recheck()
    }

    fn recheck(&self) -> Result<()> {
        self.parent.recheck()?;
        if check(&self.file, false, Some(self.identity.volume))? != self.identity {
            return Err(Error::Changed);
        }
        exact_name(&self.file, &self.name)
    }
}

fn relative_open(
    parent: &Directory,
    name: &Component,
    access: u32,
    disposition: u32,
    options: u32,
) -> Result<File> {
    let mut encoded: Vec<u16> = name.as_str().encode_utf16().collect();
    let string = UNICODE_STRING {
        Length: (encoded.len() * 2) as u16,
        MaximumLength: (encoded.len() * 2) as u16,
        Buffer: encoded.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.0.file.as_raw_handle(),
        ObjectName: &string,
        Attributes: OBJ_CASE_INSENSITIVE,
        ..Default::default()
    };
    let mut handle = ptr::null_mut();
    let mut status = IO_STATUS_BLOCK::default();
    // SAFETY: single validated component, live pinned parent, synchronous I/O,
    // no unowned pointers retained by NtCreateFile. Reparses never followed.
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            access,
            &attributes,
            &mut status,
            ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ,
            disposition,
            options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            ptr::null(),
            0,
        )
    };
    nt_result(result)?;
    // SAFETY: successful NtCreateFile transfers a new owned handle exactly once.
    Ok(unsafe { File::from_raw_handle(handle) })
}

fn check(file: &File, directory: bool, volume: Option<u64>) -> Result<Identity> {
    let mut info = Default::default();
    // SAFETY: valid live file handle and initialized correctly sized output.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(Error::Unsafe("reparse point"));
    }
    if (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory {
        return Err(Error::Unsafe("unexpected entry type"));
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_READONLY != 0 {
        return Err(Error::Access(5));
    }
    if !directory && info.nNumberOfLinks != 1 {
        return Err(Error::Unsafe("hard-linked file"));
    }
    let mut id = FILE_ID_INFO::default();
    // SAFETY: matching FILE_ID_INFO allocation and information class.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            (&mut id as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    if volume.is_some_and(|value| value != id.VolumeSerialNumber) {
        return Err(Error::Unsafe("cross-volume entry"));
    }
    if directory {
        let mut case = FILE_CASE_SENSITIVE_INFO::default();
        // SAFETY: matching information buffer and class. Unsupported queries fail closed.
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileCaseSensitiveInfo,
                (&mut case as *mut FILE_CASE_SENSITIVE_INFO).cast(),
                size_of::<FILE_CASE_SENSITIVE_INFO>() as u32,
            )
        } == 0
        {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        if case.Flags != 0 {
            return Err(Error::Unsafe("case-sensitive directory"));
        }
    }
    Ok(Identity {
        volume: id.VolumeSerialNumber,
        file_id: id.FileId.Identifier,
    })
}

fn exact_name(file: &File, expected: &Component) -> Result<()> {
    // Maximum NT Unicode path plus header. Bounded and aligned, never parsed past
    // the returned declared length. Reject an over-limit path rather than retry.
    let mut storage = vec![0u64; 8193];
    let bytes = storage.len() * 8;
    // SAFETY: aligned initialized buffer; FileNameInfo has a UTF-16 flexible tail.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileNameInfo,
            storage.as_mut_ptr().cast(),
            bytes as u32,
        )
    } == 0
    {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let info = storage.as_ptr().cast::<FILE_NAME_INFO>();
    // SAFETY: header fits allocation. Validate length before constructing slice.
    let length = unsafe { (*info).FileNameLength as usize };
    let offset = offset_of!(FILE_NAME_INFO, FileName);
    if length % 2 != 0 || length > bytes - offset {
        return Err(Error::Changed);
    }
    // SAFETY: declared tail lies inside aligned allocation, checked above.
    let units = unsafe {
        std::slice::from_raw_parts(ptr::addr_of!((*info).FileName).cast::<u16>(), length / 2)
    };
    let name = String::from_utf16(units).map_err(|_| Error::Unsafe("invalid UTF-16 name"))?;
    if name.rsplit('\\').next() != Some(expected.as_str()) {
        return Err(Error::Changed);
    }
    Ok(())
}

fn local_ntfs(file: &File) -> Result<()> {
    let mut name = [0u16; 32];
    // SAFETY: live root handle and writable filesystem name buffer only.
    if unsafe {
        GetVolumeInformationByHandleW(
            file.as_raw_handle(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            name.as_mut_ptr(),
            name.len() as u32,
        )
    } == 0
    {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    if name[..5] != [b'N' as u16, b'T' as u16, b'F' as u16, b'S' as u16, 0] {
        return Err(Error::Unsafe("only NTFS is qualified"));
    }
    let mut path = [0u16; 32768];
    // SAFETY: live handle, bounded UTF-16 output; default returns DOS volume form.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            path.as_mut_ptr(),
            path.len() as u32,
            0,
        )
    } as usize;
    if length < 7
        || length >= path.len()
        || path[..4] != [92, 92, 63, 92]
        || !((path[4] as u8).is_ascii_alphabetic() && path[4] < 128)
        || path[5..7] != [58, 92]
    {
        return Err(Error::Unsafe(
            "only local drive-letter volumes are qualified",
        ));
    }
    let drive = [path[4], 58, 92, 0];
    // SAFETY: bounded NUL-terminated root path. DRIVE_FIXED = 3.
    if unsafe { GetDriveTypeW(drive.as_ptr()) } != 3 {
        return Err(Error::Unsafe("non-fixed volume"));
    }
    Ok(())
}

fn nt_result(status: i32) -> Result<()> {
    if status < 0 {
        // SAFETY: pure conversion of NTSTATUS, no pointers/side effects.
        return Err(io_error(std::io::Error::from_raw_os_error(unsafe {
            RtlNtStatusToDosError(status)
        }
            as i32)));
    }
    Ok(())
}

fn io_error(error: std::io::Error) -> Error {
    match error.raw_os_error() {
        Some(80 | 183) => Error::Exists,
        Some(code @ (32 | 33)) => Error::Sharing(code as u32),
        Some(code @ (5 | 19)) => Error::Access(code as u32),
        Some(39 | 112) => Error::DiskFull,
        _ => Error::Io(error),
    }
}
