use std::{
    collections::HashSet,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

use zip::ZipArchive;

use crate::InspectionError;

const MAX_FILES: usize = 10_000;
const MAX_BYTES: u64 = 512 * 1024 * 1024;
const MAX_COMPRESSION_RATIO: u64 = 1_000;
const MAX_ROOT_SOURCE_BYTES: u64 = 8 * 1024 * 1024;

pub use research_workbench_native_sdk::writing_transfer::{SourceInspection, ZipEntry};

pub fn preview(source_path: &str) -> Result<SourceInspection, InspectionError> {
    let source = validated_external_source(source_path)?;
    if source.is_dir() {
        inspect_directory(&source)
    } else {
        inspect_zip(&source)
    }
}

pub fn collect_directory_files(root: &Path) -> Result<Vec<String>, InspectionError> {
    Ok(collect_directory_entries(root, true)?
        .into_iter()
        .map(|(relative_path, _)| relative_path)
        .collect())
}

pub fn validated_external_source(value: &str) -> Result<PathBuf, InspectionError> {
    let path = PathBuf::from(value.trim());
    if !path.is_absolute() {
        return Err(InspectionError::InvalidPath);
    }
    let metadata = fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink() {
        return Err(InspectionError::SymlinkNotAllowed);
    }
    let canonical = path.canonicalize()?;
    if metadata.is_dir() {
        return Ok(canonical);
    }
    if metadata.is_file()
        && path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("zip"))
    {
        return Ok(canonical);
    }
    Err(InspectionError::InvalidPath)
}

pub fn inspect_directory(source: &Path) -> Result<SourceInspection, InspectionError> {
    let entries = collect_directory_entries(source, false)?;
    let files = entries
        .iter()
        .map(|(relative_path, _)| relative_path.clone())
        .collect::<Vec<_>>();
    Ok(SourceInspection {
        byte_size: entries.iter().map(|(_, byte_size)| byte_size).sum(),
        root_candidates: discover_directory_roots(source, &files)?,
        files,
    })
}

fn collect_directory_entries(
    root: &Path,
    internal_source: bool,
) -> Result<Vec<(String, u64)>, InspectionError> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    let mut total_bytes = 0_u64;
    while let Some(directory) = pending.pop() {
        let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if research_workbench_native_sdk::resource_path::is_recovery_file_name(
                &entry.file_name().to_string_lossy(),
            ) {
                if internal_source {
                    continue;
                }
                return Err(InspectionError::InvalidPath);
            }
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.file_type().is_symlink() {
                return Err(InspectionError::SymlinkNotAllowed);
            }
            if metadata.is_dir() {
                pending.push(entry.path());
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            total_bytes = total_bytes.saturating_add(metadata.len());
            if files.len() >= MAX_FILES || total_bytes > MAX_BYTES {
                return Err(InspectionError::FileTooLarge);
            }
            let entry_path = entry.path();
            let relative = entry_path
                .strip_prefix(root)
                .map_err(|_| InspectionError::InvalidPath)?
                .to_str()
                .ok_or(InspectionError::InvalidPath)?
                .replace('\\', "/");
            research_workbench_native_sdk::resource_path::validate_relative_path(&relative)
                .map_err(|_| InspectionError::InvalidPath)?;
            files.push((relative, metadata.len()));
        }
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

fn inspect_zip(source: &Path) -> Result<SourceInspection, InspectionError> {
    let mut archive = ZipArchive::new(File::open(source)?)?;
    let entries = inspect_zip_entries(&mut archive)?;
    let root_candidates = discover_zip_roots(&mut archive, &entries)?;
    Ok(SourceInspection {
        byte_size: entries.iter().map(|entry| entry.byte_size).sum(),
        files: entries
            .iter()
            .map(|entry| entry.relative_path.clone())
            .collect(),
        root_candidates,
    })
}

pub fn inspect_zip_entries(
    archive: &mut ZipArchive<File>,
) -> Result<Vec<ZipEntry>, InspectionError> {
    if archive.len() > MAX_FILES {
        return Err(InspectionError::FileTooLarge);
    }
    let mut raw_entries = Vec::new();
    let mut total_bytes = 0_u64;
    for index in 0..archive.len() {
        let file = archive.by_index(index)?;
        if file.is_dir() || file.name().starts_with("__MACOSX/") {
            continue;
        }
        if !file.is_file() || file.encrypted() || file.is_symlink() {
            return Err(InspectionError::SymlinkNotAllowed);
        }
        total_bytes = total_bytes.saturating_add(file.size());
        if total_bytes > MAX_BYTES
            || (file.size() > 0 && file.compressed_size() == 0)
            || file.size() > file.compressed_size().saturating_mul(MAX_COMPRESSION_RATIO)
        {
            return Err(InspectionError::FileTooLarge);
        }
        let path = file.enclosed_name().ok_or(InspectionError::InvalidPath)?;
        let relative_path = path
            .to_str()
            .ok_or(InspectionError::InvalidPath)?
            .replace('\\', "/");
        research_workbench_native_sdk::resource_path::validate_relative_path(&relative_path)
            .map_err(|_| InspectionError::InvalidPath)?;
        raw_entries.push((index, relative_path, file.size()));
    }
    let paths = raw_entries
        .iter()
        .map(|(_, path, _)| path.clone())
        .collect::<Vec<_>>();
    let prefix = common_top_directory(&paths);
    let mut seen = HashSet::new();
    let mut entries = raw_entries
        .into_iter()
        .map(|(archive_index, path, byte_size)| {
            let relative_path = strip_prefix(&path, prefix.as_deref())?;
            if !seen.insert(relative_path.clone()) {
                return Err(InspectionError::InvalidPath);
            }
            Ok(ZipEntry {
                archive_index,
                relative_path,
                byte_size,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(entries)
}

pub fn discover_directory_roots(
    root: &Path,
    files: &[String],
) -> Result<Vec<String>, InspectionError> {
    let mut candidates = Vec::new();
    for relative_path in files.iter().filter(|path| path.ends_with(".tex")) {
        let bytes = fs::read(root.join(relative_path))?;
        if bytes.len() as u64 <= MAX_ROOT_SOURCE_BYTES && is_root_source(bytes) {
            candidates.push(relative_path.clone());
        }
    }
    sort_root_candidates(&mut candidates);
    Ok(candidates)
}

fn discover_zip_roots(
    archive: &mut ZipArchive<File>,
    entries: &[ZipEntry],
) -> Result<Vec<String>, InspectionError> {
    let mut candidates = Vec::new();
    for entry in entries.iter().filter(|entry| {
        entry.relative_path.ends_with(".tex") && entry.byte_size <= MAX_ROOT_SOURCE_BYTES
    }) {
        let mut file = archive.by_index(entry.archive_index)?;
        let mut bytes = Vec::with_capacity(entry.byte_size as usize);
        file.by_ref()
            .take(MAX_ROOT_SOURCE_BYTES.saturating_add(1))
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 == entry.byte_size && is_root_source(bytes) {
            candidates.push(entry.relative_path.clone());
        }
    }
    sort_root_candidates(&mut candidates);
    Ok(candidates)
}

fn is_root_source(bytes: Vec<u8>) -> bool {
    String::from_utf8(bytes).is_ok_and(|content| content.contains("\\documentclass"))
}

fn sort_root_candidates(candidates: &mut [String]) {
    candidates.sort_by_key(|path| (path != "main.tex", path.clone()));
}

fn common_top_directory(paths: &[String]) -> Option<String> {
    let first = paths.first()?.split('/').next()?;
    paths
        .iter()
        .all(|path| path.starts_with(&format!("{first}/")))
        .then(|| first.to_owned())
}

fn strip_prefix(path: &str, prefix: Option<&str>) -> Result<String, InspectionError> {
    let value = match prefix {
        Some(prefix) => path
            .strip_prefix(&format!("{prefix}/"))
            .ok_or(InspectionError::InvalidPath)?,
        None => path,
    };
    research_workbench_native_sdk::resource_path::validate_relative_path(value)
        .map_err(|_| InspectionError::InvalidPath)?;
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::{ZipWriter, write::SimpleFileOptions};

    #[test]
    fn previews_zip_roots_without_extracting_the_archive() {
        let root =
            std::env::temp_dir().join(format!("writing-source-preview-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create test root");
        let source = root.join("paper.zip");
        let file = File::create(&source).expect("create archive");
        let mut writer = ZipWriter::new(file);
        writer
            .start_file("paper/article.tex", SimpleFileOptions::default())
            .expect("start root");
        writer
            .write_all(b"\\documentclass{article}\n")
            .expect("write root");
        writer
            .start_file("paper/sections/a.tex", SimpleFileOptions::default())
            .expect("start section");
        writer.write_all(b"Section\n").expect("write section");
        writer.finish().expect("finish archive");

        let inspected = preview(source.to_str().expect("source path")).expect("preview archive");
        assert_eq!(inspected.files, ["article.tex", "sections/a.tex"]);
        assert_eq!(inspected.root_candidates, ["article.tex"]);
        assert!(!root.join("article.tex").exists());
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn rejects_zip_slip_during_preview() {
        let root =
            std::env::temp_dir().join(format!("writing-source-zipslip-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create test root");
        let source = root.join("unsafe.zip");
        let file = File::create(&source).expect("create archive");
        let mut writer = ZipWriter::new(file);
        writer
            .start_file("../escape.tex", SimpleFileOptions::default())
            .expect("start unsafe entry");
        writer
            .write_all(b"\\documentclass{article}")
            .expect("write unsafe entry");
        writer.finish().expect("finish archive");

        assert!(matches!(
            preview(source.to_str().expect("source path")),
            Err(InspectionError::InvalidPath)
        ));
        assert!(!root.join("escape.tex").exists());
        fs::remove_dir_all(root).expect("remove fixture");
    }
}
