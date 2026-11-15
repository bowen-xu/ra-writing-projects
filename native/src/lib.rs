//! Canonical import inspection and pure project/document decisions.
//! These implementations are independent from App, SQL and Tauri.
//!
//! These few filesystem helpers also serve the transitional App copy adapter;
//! copying, importing and exporting are deliberately not implemented here.
pub mod bibliography;
pub mod compile;
mod inspection;
pub mod note_assets;
pub mod projects;
pub mod transfer;

pub use inspection::{
    SourceInspection, ZipEntry, collect_directory_files, discover_directory_roots,
    inspect_directory, inspect_zip_entries, preview, validated_external_source,
};

#[derive(Debug, thiserror::Error)]
pub enum InspectionError {
    #[error("稿件路径无效")]
    InvalidPath,
    #[error("文本文件超过 8 MiB 限制")]
    FileTooLarge,
    #[error("稿件工程不允许符号链接")]
    SymlinkNotAllowed,
    #[error("稿件文件操作失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("ZIP 工程处理失败：{0}")]
    Zip(#[from] zip::result::ZipError),
}
