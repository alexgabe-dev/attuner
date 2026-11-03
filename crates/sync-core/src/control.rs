use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU8, Ordering},
};
#[derive(Clone, Default)]
pub struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GameState {
    Closed,
    Running,
    Unknown,
}
/// Only a synthetic runtime guard. This does not detect or interlock a real game.
#[derive(Clone)]
pub struct FixtureRuntime(Arc<AtomicU8>);
impl FixtureRuntime {
    pub fn closed() -> Self {
        Self(Arc::new(AtomicU8::new(0)))
    }
    pub fn set(&self, state: GameState) {
        self.0.store(
            match state {
                GameState::Closed => 0,
                GameState::Running => 1,
                GameState::Unknown => 2,
            },
            Ordering::SeqCst,
        );
    }
    pub fn state(&self) -> GameState {
        match self.0.load(Ordering::SeqCst) {
            0 => GameState::Closed,
            1 => GameState::Running,
            _ => GameState::Unknown,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Point {
    Discover,
    ScanEntry,
    HashChunk,
    ScanValidated,
    BackupChunk,
    BackupVerified,
    BackupReused,
    BackupEncode,
    BackupFlush,
    BackupObjectVerify,
    CaptureScan,
    CaptureDatabase,
    StageChunk,
    Prepared,
    Intent,
    Evacuated,
    Installed,
    StepDurable,
    BeforeVerification,
    BeforeCommit,
    Committed,
    RecoveryIntent,
    RecoveryEvacuated,
    RecoveryInstalled,
    Recovered,
}
#[derive(Clone, Debug)]
pub struct Event {
    pub point: Point,
    pub index: usize,
    pub path: String,
    pub elapsed_micros: Option<u64>,
}
type Observer = Arc<dyn Fn(&Event) -> Result<()> + Send + Sync>;
#[derive(Clone)]
pub struct Control {
    pub cancellation: Cancellation,
    pub runtime: FixtureRuntime,
    pub disk_budget: Option<u64>,
    observer: Option<Observer>,
}
impl Control {
    pub fn fixture() -> Self {
        Self {
            cancellation: Cancellation::default(),
            runtime: FixtureRuntime::closed(),
            disk_budget: None,
            observer: None,
        }
    }
    pub fn with_observer(
        mut self,
        observer: impl Fn(&Event) -> Result<()> + Send + Sync + 'static,
    ) -> Self {
        self.observer = Some(Arc::new(observer));
        self
    }
    pub fn check(&self) -> Result<()> {
        if self.runtime.state() != GameState::Closed {
            return Err(Error::GameState);
        }
        if self.cancellation.is_cancelled() {
            return Err(Error::Cancelled);
        }
        Ok(())
    }
    pub(crate) fn event(&self, point: Point, index: usize, path: &str) -> Result<()> {
        self.event_elapsed(point, index, path, None)
    }
    pub(crate) fn timed(
        &self,
        point: Point,
        index: usize,
        path: &str,
        start: std::time::Instant,
    ) -> Result<()> {
        self.event_elapsed(
            point,
            index,
            path,
            Some(start.elapsed().as_micros().min(u64::MAX as u128) as u64),
        )
    }
    fn event_elapsed(
        &self,
        point: Point,
        index: usize,
        path: &str,
        elapsed_micros: Option<u64>,
    ) -> Result<()> {
        self.check()?;
        tracing::trace!(?point, index, path, "local engine checkpoint");
        if let Some(observer) = &self.observer {
            observer(&Event {
                point,
                index,
                path: path.to_owned(),
                elapsed_micros,
            })?;
        }
        self.check()
    }
}
#[derive(Clone, Debug)]
pub struct Limits {
    pub max_file_bytes: u64,
    pub max_scan_bytes: u64,
    pub max_entries: usize,
    pub max_depth: usize,
    pub disk_reserve: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_file_bytes: 1024 * 1024 * 1024,
            max_scan_bytes: 4 * 1024 * 1024 * 1024,
            max_entries: 100_000,
            max_depth: 64,
            disk_reserve: 16 * 1024 * 1024,
        }
    }
}
