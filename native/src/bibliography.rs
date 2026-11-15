//! Canonical BibTeX parsing and retention without database or file ownership.
pub mod adoption;
pub mod entries;
pub mod mutation;
pub mod normalize;
pub mod parse;
pub mod proof;
pub mod publication;
pub mod recovery;
pub mod rekey;
pub mod rekey_text;
pub mod resources;
mod retention;
pub use retention::retain;

pub use research_workbench_native_sdk::writing_bibliography::BibliographyError as Error;
