use thiserror::Error;
#[derive(Debug, Error)]
pub enum Error {
    #[error("Filesystem operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("Local database operation failed: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("Invalid metadata: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Unsafe or unsupported entry: {0}")]
    UnsafePath(String),
    #[error("Unsupported fixture adapter")]
    Adapter,
    #[error("Game state is running or uncertain")]
    GameState,
    #[error("Operation cancelled")]
    Cancelled,
    #[error("Workspace is busy")]
    Busy,
    #[error("Scan was incomplete or changed during capture: {0}")]
    Incomplete(String),
    #[error("Scan coverage, workspace or policy does not match")]
    Coverage,
    #[error("Content verification failed: {0}")]
    Integrity(String),
    #[error("Concurrent changes were preserved: {0}")]
    Concurrent(String),
    #[error("Resource limit exceeded: {0}")]
    Limit(String),
    #[error("Insufficient disk budget: need {required}, available {available}")]
    NoSpace { required: u64, available: u64 },
    #[error("Operation {operation} requires recovery: {reason}")]
    RecoveryRequired { operation: i64, reason: String },
    #[error("An interrupted operation must be recovered first")]
    PendingRecovery,
    #[error("Snapshot or operation not found")]
    NotFound,
    #[error("Durable local fixture operations are not enabled on this platform")]
    Platform,
}
pub type Result<T> = std::result::Result<T, Error>;
