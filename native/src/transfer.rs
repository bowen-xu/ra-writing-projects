//! Original transfer rules and the existing read-only source inspection.
use crate::{InspectionError, inspection, projects::ProjectError};
use research_workbench_native_sdk::writing_transfer::{Decision, Input, RejectionCode, ZipHeader};
use std::{fs::File, path::Path};
use zip::ZipArchive;

pub fn select_root_path(
    candidates: &[String],
    requested: Option<&str>,
) -> Result<String, ProjectError> {
    if candidates.is_empty() {
        return Err(ProjectError::InvalidManuscript);
    }
    if let Some(requested) = requested {
        let requested = requested.trim();
        research_workbench_native_sdk::resource_path::validate_relative_path(requested)
            .map_err(|_| ProjectError::InvalidPath)?;
        return candidates
            .iter()
            .find(|candidate| candidate.as_str() == requested)
            .cloned()
            .ok_or(ProjectError::InvalidManuscript);
    }
    Ok(candidates
        .iter()
        .find(|path| path.as_str() == "main.tex")
        .unwrap_or(&candidates[0])
        .clone())
}

pub fn duplicate_title(title: &str) -> String {
    format!("{}（副本）", title.chars().take(175).collect::<String>())
}

pub fn decide(input: &Input) -> Decision {
    match input {
        Input::SelectRoot {
            candidates,
            requested,
        } => {
            return match select_root_path(candidates, requested.as_deref()) {
                Ok(relative_path) => Decision::Root { relative_path },
                Err(reason) => Decision::Rejected {
                    code: RejectionCode::InvalidInput,
                    message: reason.to_string(),
                },
            };
        }
        Input::DuplicateTitle { title } => {
            return Decision::Title {
                title: duplicate_title(title),
            };
        }
        _ => {}
    }
    match inspect(input) {
        Ok(decision) => decision,
        Err(cause) => Decision::Rejected {
            code: match &cause {
                InspectionError::InvalidPath => RejectionCode::InvalidInput,
                InspectionError::FileTooLarge => RejectionCode::FileTooLarge,
                InspectionError::SymlinkNotAllowed => RejectionCode::UnsafePath,
                InspectionError::Io(_) | InspectionError::Zip(_) => RejectionCode::StorageError,
            },
            message: cause.to_string(),
        },
    }
}

fn inspect(input: &Input) -> Result<Decision, InspectionError> {
    match input {
        Input::InspectImport { source_path } => {
            let source = inspection::validated_external_source(source_path)?;
            if source.is_dir() {
                return Ok(Decision::Directory {
                    inspection: inspection::inspect_directory(&source)?,
                });
            }
            let mut archive = ZipArchive::new(File::open(source)?)?;
            let entries = inspection::inspect_zip_entries(&mut archive)?;
            let headers = (0..archive.len())
                .map(|index| {
                    let file = archive.by_index(index)?;
                    Ok(ZipHeader {
                        name: file.name().into(),
                        size: file.size(),
                        compressed_size: file.compressed_size(),
                        crc32: file.crc32(),
                        is_dir: file.is_dir(),
                        is_file: file.is_file(),
                        is_symlink: file.is_symlink(),
                        encrypted: file.encrypted(),
                    })
                })
                .collect::<Result<Vec<_>, zip::result::ZipError>>()?;
            Ok(Decision::Zip { entries, headers })
        }
        Input::InspectExport { directory } => Ok(Decision::Files {
            files: inspection::collect_directory_files(Path::new(directory))?,
        }),
        Input::DiscoverRoots { directory, files } => {
            for path in files {
                research_workbench_native_sdk::resource_path::validate_relative_path(path)
                    .map_err(|_| InspectionError::InvalidPath)?;
            }
            Ok(Decision::Roots {
                candidates: inspection::discover_directory_roots(Path::new(directory), files)?,
            })
        }
        _ => Err(InspectionError::InvalidPath),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Write};
    use zip::{ZipWriter, write::SimpleFileOptions};

    #[test]
    fn preserves_original_root_selection_and_unicode_copy_title() {
        let candidates = vec!["appendix/root.tex".into(), "main.tex".into()];
        assert_eq!(select_root_path(&candidates, None).unwrap(), "main.tex");
        assert_eq!(
            select_root_path(&candidates, Some(" appendix/root.tex ")).unwrap(),
            "appendix/root.tex"
        );
        assert_eq!(
            select_root_path(&candidates, Some("../root.tex")),
            Err(ProjectError::InvalidPath)
        );
        assert_eq!(
            select_root_path(&[], None),
            Err(ProjectError::InvalidManuscript)
        );
        assert_eq!(
            duplicate_title(&"稿".repeat(180)),
            format!("{}（副本）", "稿".repeat(175))
        );
    }

    #[test]
    fn source_inspection_keeps_all_zip_headers_and_original_prefix_rules() {
        let root =
            std::env::temp_dir().join(format!("writing-transfer-wire-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("source.zip");
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        for (name, bytes) in [
            ("paper/main.tex", "\\documentclass{article}"),
            ("paper/sections/a.tex", "Section"),
            ("__MACOSX/ignored", "Ignored"),
        ] {
            zip.start_file(name, SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        let Decision::Zip { entries, headers } = decide(&Input::InspectImport {
            source_path: path.to_string_lossy().into(),
        }) else {
            panic!("zip inspection")
        };
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["main.tex", "sections/a.tex"]
        );
        assert_eq!(headers.len(), 3);
        assert_eq!(headers[2].name, "__MACOSX/ignored");
        assert!(
            headers
                .iter()
                .all(|header| header.is_file && !header.encrypted && !header.is_symlink)
        );
        fs::remove_dir_all(root).unwrap();
    }
}
