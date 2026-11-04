//! Isolated synthetic immutable-pack experiment. No production engine dependency,
//! ambient workspace constructor, deletion/GC or Windows durability claim.
#[cfg(unix)]
mod experiment;
#[cfg(unix)]
pub use experiment::*;
