use crate::{Error, Result};
use zeroize::Zeroizing;
/// Production hosts use OsCredentialStore. No file-backed or plaintext fallback exists.
pub trait CredentialStore: Send + Sync {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>>;
    fn write(&self, account: &str, secret: &[u8]) -> Result<()>;
    fn delete(&self, account: &str) -> Result<()>;
}
pub struct OsCredentialStore {
    service: String,
}
impl Default for OsCredentialStore {
    fn default() -> Self {
        Self {
            service: "app.attuner.desktop".into(),
        }
    }
}
#[cfg(any(target_os = "macos", target_os = "windows"))]
impl OsCredentialStore {
    fn entry(&self, account: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, account).map_err(|_| Error::Credentials)
    }
}
#[cfg(any(target_os = "macos", target_os = "windows"))]
impl CredentialStore for OsCredentialStore {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        match self.entry(account)?.get_secret() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(Error::Credentials),
        }
    }
    fn write(&self, account: &str, value: &[u8]) -> Result<()> {
        if value.len() > 2048 {
            return Err(Error::Limit);
        }
        self.entry(account)?
            .set_secret(value)
            .map_err(|_| Error::Credentials)
    }
    fn delete(&self, account: &str) -> Result<()> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(Error::Credentials),
        }
    }
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl CredentialStore for OsCredentialStore {
    fn read(&self, _: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        let _ = &self.service;
        Err(Error::Credentials)
    }
    fn write(&self, _: &str, _: &[u8]) -> Result<()> {
        Err(Error::Credentials)
    }
    fn delete(&self, _: &str) -> Result<()> {
        Err(Error::Credentials)
    }
}
#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
mod tests {
    use super::*;
    #[test]
    fn native_os_secret_round_trip_has_no_file_fallback() {
        let store = OsCredentialStore {
            service: "app.attuner.desktop.tests".into(),
        };
        let account = uuid::Uuid::new_v4().to_string();
        let secret = uuid::Uuid::new_v4().as_bytes().to_vec();
        store.write(&account, &secret).expect("OS credential write");
        let found = store
            .read(&account)
            .expect("OS credential read")
            .expect("saved credential");
        assert!(found.as_slice() == secret.as_slice());
        store
            .delete(&account)
            .expect("remove owned synthetic credential");
        assert!(store.read(&account).unwrap().is_none());
    }
}
