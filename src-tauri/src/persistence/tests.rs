use super::*;
use std::{
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

struct Fixture {
    directory: PathBuf,
    root: PathBuf,
    state: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "blueprint-save-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let root = directory.join("repository");
        fs::create_dir_all(root.join(".github/agents")).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let state = directory.join("state");
        Self {
            directory,
            root,
            state,
        }
    }

    fn files(&self) -> Vec<OutputFile> {
        ["one", "new", "two"]
            .into_iter()
            .map(|name| OutputFile {
                path: format!(".github/agents/{name}.agent.md"),
                content: format!("new {name}"),
            })
            .collect()
    }

    fn originals(&self) {
        for name in ["one", "two"] {
            fs::write(
                self.root.join(format!(".github/agents/{name}.agent.md")),
                format!("old {name}"),
            )
            .unwrap();
        }
    }

    fn assert_old(&self) {
        for name in ["one", "two"] {
            assert_eq!(
                fs::read_to_string(self.root.join(format!(".github/agents/{name}.agent.md")))
                    .unwrap(),
                format!("old {name}")
            );
        }
        assert!(!self.root.join(".github/agents/new.agent.md").exists());
        assert_eq!(
            fs::read_dir(self.root.join(".github/agents"))
                .unwrap()
                .count(),
            2
        );
    }

    fn assert_new(&self) {
        for file in self.files() {
            assert_eq!(
                fs::read_to_string(self.root.join(file.path)).unwrap(),
                file.content
            );
        }
        assert_eq!(
            fs::read_dir(self.root.join(".github/agents"))
                .unwrap()
                .count(),
            3
        );
    }

    fn worker(&self, checkpoint: &str) -> std::process::Output {
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "persistence::tests::crash_worker", "--nocapture"])
            .env("BLUEPRINT_CRASH_ROOT", &self.root)
            .env("BLUEPRINT_CRASH_STATE", &self.state)
            .env("BLUEPRINT_CHECKPOINT", checkpoint)
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.directory).unwrap();
    }
}

#[test]
fn saves_all_files_and_cleans_the_journal() {
    let fixture = Fixture::new();
    fixture.originals();
    let store = SaveStore::open(fixture.state.clone()).unwrap();
    let result = store
        .save(
            &fixture.root,
            fixture.files(),
            |_| true,
            |paths| {
                assert_eq!(paths.len(), 2);
                true
            },
        )
        .unwrap();
    assert!(result.saved);
    assert!(result.recovered.is_none());
    fixture.assert_new();
    assert!(!store.journal_path().exists());
}

#[test]
fn releasing_the_lock_does_not_wait_for_an_inherited_descriptor() {
    let fixture = Fixture::new();
    let store = SaveStore::open(fixture.state.clone()).unwrap();
    let inherited = store._lock.try_clone().unwrap();
    drop(store);
    let next = SaveStore::open(fixture.state.clone()).unwrap();
    drop(next);
    drop(inherited);
}

#[test]
fn json_drafts_use_the_same_lock_and_rollback_engine() {
    let fixture = Fixture::new();
    fixture.originals();
    let store = SaveStore::open(fixture.state.clone()).unwrap();
    let draft = OutputFile {
        path: "work.blueprint.json".into(),
        content: r#"{"version":1}"#.into(),
    };
    let allowed_path = fixture.root.join(&draft.path);
    assert!(
        store
            .save(
                &fixture.root,
                vec![draft.clone()],
                |path| path == allowed_path,
                |_| true
            )
            .unwrap()
            .saved
    );
    fixture.assert_old();
    let old = contents(&allowed_path).unwrap().unwrap();
    let changed = OutputFile {
        content: r#"{"version":2}"#.into(),
        ..draft
    };
    let mut journal = store
        .prepare(&fixture.root, vec![changed], |_| true, |_| true)
        .unwrap()
        .unwrap();
    store.install(&mut journal, 0).unwrap();
    drop(store);
    let restarted = SaveStore::open(fixture.state.clone()).unwrap();
    restarted.recover().unwrap();
    assert_eq!(contents(&allowed_path).unwrap().unwrap(), old);
    fixture.assert_old();
}

#[test]
fn output_cannot_overwrite_its_own_recovery_journal() {
    let fixture = Fixture::new();
    let store = SaveStore::open(fixture.state.clone()).unwrap();
    let output = OutputFile {
        path: "transaction.json".into(),
        content: "{}".into(),
    };
    assert!(store
        .save(&fixture.state, vec![output], |_| true, |_| true)
        .err()
        .unwrap()
        .contains("recovery directory"));
}

#[test]
fn declined_overwrite_including_empty_files_keeps_originals() {
    let fixture = Fixture::new();
    fixture.originals();
    fs::write(fixture.root.join(".github/agents/one.agent.md"), "").unwrap();
    let store = SaveStore::open(fixture.state.clone()).unwrap();
    let result = store
        .save(
            &fixture.root,
            fixture.files(),
            |_| true,
            |paths| {
                assert_eq!(paths.len(), 2);
                false
            },
        )
        .unwrap();
    assert!(!result.saved);
    assert_eq!(
        fs::read_to_string(fixture.root.join(".github/agents/one.agent.md")).unwrap(),
        ""
    );
    assert!(!store.journal_path().exists());
}

#[test]
fn edits_during_approval_are_not_overwritten() {
    let fixture = Fixture::new();
    fixture.originals();
    let store = SaveStore::open(fixture.state.clone()).unwrap();
    let error = store
        .save(
            &fixture.root,
            fixture.files(),
            |_| true,
            |_| {
                fs::write(
                    fixture.root.join(".github/agents/two.agent.md"),
                    "external edit",
                )
                .unwrap();
                true
            },
        )
        .err()
        .unwrap();
    assert!(error.contains("changed during export"), "{error}");
    assert_eq!(
        fs::read_to_string(fixture.root.join(".github/agents/one.agent.md")).unwrap(),
        "old one"
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join(".github/agents/two.agent.md")).unwrap(),
        "external edit"
    );
    assert!(!fixture.root.join(".github/agents/new.agent.md").exists());
    assert!(!store.journal_path().exists());
}

#[test]
fn rejects_traversal_scope_violations_and_case_collisions() {
    let fixture = Fixture::new();
    let store = SaveStore::open(fixture.state.clone()).unwrap();
    assert!(store
        .save(&fixture.root, fixture.files(), |_| false, |_| true)
        .is_err());
    for path in [
        "/tmp/outside",
        ".github/../escape",
        ".github/agents/.blueprint-owned.tmp",
    ] {
        assert!(store
            .save(
                &fixture.root,
                vec![OutputFile {
                    path: path.into(),
                    content: String::new()
                }],
                |_| true,
                |_| true
            )
            .is_err());
    }
    let duplicate = vec![
        OutputFile {
            path: ".github/agents/Review.md".into(),
            content: "first".into(),
        },
        OutputFile {
            path: ".github/agents/review.md".into(),
            content: "second".into(),
        },
    ];
    assert!(store
        .save(&fixture.root, duplicate, |_| true, |_| true)
        .err()
        .unwrap()
        .contains("duplicate"));
    assert!(!store.journal_path().exists());
}

#[cfg(unix)]
#[test]
fn rejects_symlink_targets_and_directories() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let outside = fixture.directory.join("outside");
    fs::write(&outside, "untouched").unwrap();
    let target = fixture.root.join(".github/agents/one.agent.md");
    symlink(&outside, &target).unwrap();
    let store = SaveStore::open(fixture.state.clone()).unwrap();
    assert!(store
        .save(&fixture.root, fixture.files(), |_| true, |_| true)
        .is_err());
    fs::remove_file(target).unwrap();
    fs::remove_dir(fixture.root.join(".github/agents")).unwrap();
    symlink(&fixture.directory, fixture.root.join(".github/agents")).unwrap();
    assert!(store
        .save(&fixture.root, fixture.files(), |_| true, |_| true)
        .is_err());
    assert_eq!(fs::read_to_string(outside).unwrap(), "untouched");
}

#[test]
fn abrupt_exit_releases_the_lock_and_restores_every_started_write() {
    for checkpoint in [
        "prepared",
        "intent",
        "partial-stage",
        "first",
        "second",
        "last",
        "rollback",
    ] {
        let fixture = Fixture::new();
        fixture.originals();
        let output = fixture.worker(checkpoint);
        assert_eq!(
            output.status.code(),
            Some(77),
            "{checkpoint}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let store = SaveStore::open(fixture.state.clone()).unwrap();
        assert!(store.recover().unwrap().unwrap().contains("Restored"));
        fixture.assert_old();
        assert!(!store.journal_path().exists());
        assert!(store.recover().unwrap().is_none());
    }
}

#[test]
fn crash_after_commit_keeps_the_complete_new_export() {
    let fixture = Fixture::new();
    fixture.originals();
    assert_eq!(fixture.worker("committed").status.code(), Some(77));
    let store = SaveStore::open(fixture.state.clone()).unwrap();
    assert!(store.recover().unwrap().unwrap().contains("completed save"));
    fixture.assert_new();
    assert!(!store.journal_path().exists());
}

#[test]
fn another_process_cannot_save_while_the_lock_is_held() {
    let fixture = Fixture::new();
    let _store = SaveStore::open(fixture.state.clone()).unwrap();
    let output = fixture.worker("lock");
    assert_eq!(
        output.status.code(),
        Some(78),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn recovery_preserves_external_edits_and_keeps_originals_available() {
    let fixture = Fixture::new();
    fixture.originals();
    assert_eq!(fixture.worker("second").status.code(), Some(77));
    let path = fixture.root.join(".github/agents/one.agent.md");
    fs::write(&path, "new external edit").unwrap();
    let store = SaveStore::open(fixture.state.clone()).unwrap();
    let error = store.recover().unwrap_err();
    assert!(error.contains("Recovery needs attention"));
    assert_eq!(fs::read_to_string(&path).unwrap(), "new external edit");
    assert!(!fixture.root.join(".github/agents/new.agent.md").exists());
    let journal = store.load().unwrap().unwrap();
    assert_eq!(journal.entries[0].original.as_deref(), Some("old one"));
    assert!(store
        .save(&fixture.root, fixture.files(), |_| true, |_| true)
        .is_err());
    fs::write(&path, "old one").unwrap();
    store.recover().unwrap();
    fixture.assert_old();
}

#[test]
fn next_save_recovers_an_interrupted_export_before_starting() {
    let fixture = Fixture::new();
    fixture.originals();
    assert_eq!(fixture.worker("second").status.code(), Some(77));
    let store = SaveStore::open(fixture.state.clone()).unwrap();
    let result = store
        .save(&fixture.root, fixture.files(), |_| true, |_| true)
        .unwrap();
    assert!(result.saved);
    assert!(result.recovered.unwrap().contains("Restored"));
    fixture.assert_new();
}

#[test]
fn corrupt_journal_blocks_writes_without_touching_destination() {
    let fixture = Fixture::new();
    fixture.originals();
    let store = SaveStore::open(fixture.state.clone()).unwrap();
    fs::write(store.journal_path(), "{").unwrap();
    assert!(store
        .save(&fixture.root, fixture.files(), |_| true, |_| true)
        .is_err());
    fixture.assert_old();
    assert!(store.journal_path().exists());
}

#[cfg(unix)]
#[test]
fn file_permissions_and_private_recovery_data_are_preserved() {
    let fixture = Fixture::new();
    fixture.originals();
    let path = fixture.root.join(".github/agents/one.agent.md");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    assert_eq!(fixture.worker("first").status.code(), Some(77));
    let store = SaveStore::open(fixture.state.clone()).unwrap();
    assert_eq!(
        fs::metadata(store.journal_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    store.recover().unwrap();
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o640
    );
}

#[test]
fn crash_worker() {
    let Ok(root) = std::env::var("BLUEPRINT_CRASH_ROOT") else {
        return;
    };
    let state = PathBuf::from(std::env::var("BLUEPRINT_CRASH_STATE").unwrap());
    let checkpoint = std::env::var("BLUEPRINT_CHECKPOINT").unwrap();
    if checkpoint == "lock" {
        assert!(SaveStore::open(state).is_err());
        std::process::exit(78);
    }
    let store = SaveStore::open(state).unwrap();
    let files = ["one", "new", "two"]
        .into_iter()
        .map(|name| OutputFile {
            path: format!(".github/agents/{name}.agent.md"),
            content: format!("new {name}"),
        })
        .collect();
    let mut journal = store
        .prepare(Path::new(&root), files, |_| true, |_| true)
        .unwrap()
        .unwrap();
    if checkpoint == "prepared" {
        std::process::exit(77);
    }
    if checkpoint == "intent" || checkpoint == "partial-stage" {
        journal.started = 1;
        store.store(&journal).unwrap();
        if checkpoint == "partial-stage" {
            fs::write(SaveStore::temporary(&journal, 0), [b'x', 0xf0]).unwrap();
        }
        std::process::exit(77);
    }
    for index in 0..3 {
        store.install(&mut journal, index).unwrap();
        if (checkpoint == "first" && index == 0) || (checkpoint == "second" && index == 1) {
            std::process::exit(77);
        }
    }
    if checkpoint == "committed" {
        journal.committed = true;
        store.store(&journal).unwrap();
    }
    if checkpoint == "rollback" {
        store
            .replace(
                &journal,
                2,
                journal.entries[2].original.as_ref().unwrap(),
                false,
            )
            .unwrap();
    }
    std::process::exit(77);
}
