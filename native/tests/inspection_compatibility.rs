use std::{fs, path::PathBuf};

use research_writing_projects_native::{InspectionError, collect_directory_files, preview};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("writing-inspection-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create fixture");
        Self(path)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn preserves_directory_order_root_detection_and_legacy_path_grammar() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.0.join(".git")).unwrap();
    for path in ["z.tex", "main.tex", ".git/a.tex", "quote\".tex"] {
        fs::write(fixture.0.join(path), b"\\documentclass{article}").unwrap();
    }
    fs::write(fixture.0.join("not-utf8.tex"), [0xff, 0xfe]).unwrap();
    fs::write(fixture.0.join("uppercase.TEX"), b"\\documentclass{article}").unwrap();

    let result = preview(fixture.0.to_str().unwrap()).unwrap();
    assert_eq!(result.files.len(), 6);
    assert_eq!(
        result.root_candidates,
        ["main.tex", ".git/a.tex", "quote\".tex", "z.tex"]
    );
    let mut sorted = result.files.clone();
    sorted.sort();
    assert_eq!(result.files, sorted);
}

#[test]
fn external_recovery_name_fails_but_internal_collection_preserves_skip_policy() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("main.tex"), b"\\documentclass{article}").unwrap();
    fs::write(fixture.0.join(".AGENT-BEFORE-owned.bak"), b"backup").unwrap();

    assert!(matches!(
        preview(fixture.0.to_str().unwrap()),
        Err(InspectionError::InvalidPath)
    ));
    assert_eq!(collect_directory_files(&fixture.0).unwrap(), ["main.tex"]);
}

#[test]
fn preserves_invalid_input_and_io_error_messages() {
    assert_eq!(
        preview("relative.zip").err().unwrap().to_string(),
        "稿件路径无效"
    );
    let fixture = Fixture::new();
    let missing = fixture.0.join("missing.zip");
    let error = preview(missing.to_str().unwrap()).err().unwrap();
    assert!(matches!(error, InspectionError::Io(_)));
    assert!(error.to_string().starts_with("稿件文件操作失败："));
    assert_eq!(
        InspectionError::FileTooLarge.to_string(),
        "文本文件超过 8 MiB 限制"
    );
}

#[cfg(unix)]
#[test]
fn preserves_direct_symlink_rejection_and_canonicalized_parent_links() {
    let fixture = Fixture::new();
    let real = fixture.0.join("real");
    fs::create_dir_all(real.join("source")).unwrap();
    fs::write(real.join("source/main.tex"), b"\\documentclass{article}").unwrap();
    std::os::unix::fs::symlink(&real, fixture.0.join("parent-link")).unwrap();
    std::os::unix::fs::symlink(real.join("source"), fixture.0.join("source-link")).unwrap();

    assert!(matches!(
        preview(fixture.0.join("source-link").to_str().unwrap()),
        Err(InspectionError::SymlinkNotAllowed)
    ));
    assert_eq!(
        preview(fixture.0.join("parent-link/source").to_str().unwrap())
            .unwrap()
            .root_candidates,
        ["main.tex"]
    );
}
