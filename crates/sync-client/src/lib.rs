//! HTTPS transport and device enrollment. Filesystem safety remains in sync-core.
mod credential;
mod device;
mod transport;
pub use credential::{CredentialStore, OsCredentialStore};
pub use device::{DeviceClient, DeviceStatus, Enrollment};
pub use transport::{PublicServer, ServerConnection};
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("The secure credential service is unavailable. No plaintext fallback is permitted.")]
    Credentials,
    #[error("The HTTPS server could not be verified or reached.")]
    Transport,
    #[error("The server address or response is not supported.")]
    Protocol,
    #[error("A local resource limit was exceeded.")]
    Limit,
    #[error("Reconnect this device to continue.")]
    Authentication,
    #[error("The enrollment callback did not match this device's pending request.")]
    Enrollment,
    #[error("The operation was cancelled.")]
    Cancelled,
    #[error("The server requires a fresh synchronization comparison.")]
    HeadMoved,
    #[error("The server rejected this operation ({0}).")]
    Rejected(u16),
    #[error("Local synchronization failed: {0}")]
    Engine(#[from] attuner_sync_core::Error),
    #[error("Local I/O failed: {0}")]
    Io(#[from] std::io::Error),
}
pub type Result<T> = std::result::Result<T, Error>;
