//! Framework-independent local synchronization. Only minted synthetic workspaces are supported.
pub mod protocol;
pub use protocol::{Manifest, ManifestFile, PROTOCOL_VERSION, portable_path};
pub mod adapter;
pub mod control;
pub mod error;
pub mod scan;
pub mod workspace;
pub use adapter::Adapter;
pub use control::{Cancellation, Control, Event, FixtureRuntime, GameState, Limits, Point};
pub use error::{Error, Result};
pub use scan::{CompleteScan, Coverage};
pub use workspace::Workspace;
mod backup;
pub mod compare;
mod store;
pub use backup::Verification;
pub use store::{Operation, Snapshot, SnapshotSummary};
mod engine;
pub use engine::Engine;
#[cfg(unix)]
mod apply;
#[cfg(unix)]
mod recovery;
#[cfg(unix)]
pub use apply::write_synthetic_file;
pub mod namespace;
pub mod remote;

pub mod synchronization;

mod transfer_stage;
pub use transfer_stage::DownloadStage;

mod registry;
pub use registry::{FixtureRegistry, RegisteredFixture};
