use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "blueprint-agents-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove isolated agent fixtures");
    }
}

#[test]
fn profiles_parse_real_yaml_and_preserve_tools_models_and_secret_references() {
    let profile = parse_profile(
        "---\nname: 'Code review'\ndescription: >-\n  Review changes\n  carefully.\nmodel: future-model\ntools: read, search\nmcp-servers:\n  example:\n    type: stdio\n    command: example-server\n    env:\n      TOKEN: ${{ secrets.TOKEN }}\n---\n\nReview without editing.\n",
        "review.agent.md".into(), "project",
    ).unwrap();
    assert_eq!(profile.name, "Code review");
    assert_eq!(profile.model.as_deref(), Some("future-model"));
    assert_eq!(profile.tools, ["read", "search"]);
    assert_eq!(profile.prompt, "Review without editing.");
    assert_eq!(
        serde_json::to_value(&profile).unwrap()["mcpServers"]["example"]["type"],
        "local"
    );
    let unrestricted = parse_profile(
        "---\ndescription: Test\n---\nPrompt",
        "test.md".into(),
        "personal",
    )
    .unwrap();
    assert_eq!(unrestricted.name, "test");
    assert_eq!(unrestricted.tools, ["*"]);
    let restricted = parse_profile(
        "---\ndescription: Test\ntools: []\n---\nPrompt",
        "test.md".into(),
        "personal",
    )
    .unwrap();
    assert!(restricted.tools.is_empty());
    for tools in ["null", "~"] {
        assert!(
            parse_profile(
                &format!("---\ndescription: Test\ntools: {tools}\n---\nPrompt"),
                "test.md".into(),
                "personal",
            )
            .is_err(),
            "An explicit {tools} must not grant all tools"
        );
    }
    for value in ["$TOKEN", "${TOKEN}", "${{ vars.TOKEN }}"] {
        assert!(secret_reference(value));
    }
    for value in [
        "literal-token",
        "${TOKEN:-secret}",
        "$",
        "${{ secrets.TOKEN }}suffix",
    ] {
        assert!(!secret_reference(value));
    }
    let secret = "---\ndescription: Test\nmcp-servers:\n  example:\n    type: local\n    command: example\n    env:\n      TOKEN: private-value\n---\nPrompt";
    let error = parse_profile(secret, "test.md".into(), "project")
        .err()
        .unwrap();
    assert!(error.contains("secret references"));
    assert!(!error.contains("private-value"));
    assert!(parse_profile(
        "---\nname: [invalid]\ndescription: Test\n---\nPrompt",
        "test.md".into(),
        "project"
    )
    .is_err());
    assert!(parse_profile("---\ndescription: Test\n---\n", "test.md".into(), "project").is_err());
    assert!(parse_profile(
        &format!("---\ndescription: Test\n---\n{}", "x".repeat(30_001)),
        "test.md".into(),
        "project"
    )
    .is_err());
    let windows = parse_profile(
        "\u{feff}---\r\ndescription: Test\r\ntools: ['read', 'search']\r\nmetadata:\r\n  local-note: not-imported\r\n---\r\nPrompt",
        "review.agent.agent.md".into(), "project",
    ).unwrap();
    assert_eq!(windows.name, "review.agent");
    assert_eq!(windows.tools, ["read", "search"]);
    assert_eq!(windows.prompt, "Prompt");
    assert!(windows.warnings[0].contains("metadata"));
    assert!(!serde_json::to_string(&windows)
        .unwrap()
        .contains("not-imported"));
    for header in [
        "tools: [read]\ntools: ['*']",
        "target: vscode",
        "mcp-servers:\n  example:\n    type: http\n    url: https://example.test\n    headers:\n      Authorization: private-value",
        "mcp-servers:\n  example:\n    type: http\n    url: https://user:private-value@example.test",
    ] {
        let error = parse_profile(
            &format!("---\ndescription: Test\n{header}\n---\nPrompt"),
            "test.md".into(), "project",
        ).err().expect("unsafe/ambiguous settings must be rejected");
        assert!(!error.contains("private-value"));
    }
}

#[test]
fn discovery_is_read_only_scoped_reports_bad_files_and_never_follows_links() {
    use std::os::unix::fs::symlink;
    let fixture = TestDirectory::new();
    let directory = &fixture.0;
    let project = directory.join("project");
    let home = directory.join("home");
    let project_agents = project.join(".github/agents");
    let personal_agents = home.join(".copilot/agents");
    fs::create_dir_all(project_agents.join("nested")).unwrap();
    fs::create_dir_all(&personal_agents).unwrap();
    let text = "---\ndescription: Review\n---\nDo not modify files.";
    fs::write(project_agents.join("review.agent.md"), text).unwrap();
    fs::write(personal_agents.join("review.agent.md"), text).unwrap();
    fs::write(project_agents.join("nested/second.md"), text).unwrap();
    fs::write(project_agents.join("broken.md"), "not a profile").unwrap();
    let secret = directory.join("outside.md");
    fs::write(&secret, "not-a-real-credential").unwrap();
    symlink(&secret, project_agents.join("link.md")).unwrap();
    symlink(directory, project_agents.join("linked-directory")).unwrap();
    let catalogue = discover(Some(&project), &home, |path| path.starts_with(&project));
    assert_eq!(catalogue.profiles.len(), 3);
    assert_eq!(catalogue.issues.len(), 3);
    assert!(catalogue
        .profiles
        .iter()
        .any(|profile| profile.id == "personal:review.agent.md"));
    assert!(catalogue
        .profiles
        .iter()
        .any(|profile| profile.id == "project:review.agent.md"));
    assert_eq!(
        fs::read_to_string(project_agents.join("review.agent.md")).unwrap(),
        text
    );
    assert!(!serde_json::to_string(&catalogue)
        .unwrap()
        .contains("not-a-real-credential"));
    let ungranted = discover(Some(&project), &home, |_| false);
    assert_eq!(
        ungranted.profiles.len(),
        1,
        "Project access failures must not hide personal profiles"
    );
    assert!(ungranted
        .issues
        .iter()
        .any(|issue| issue.contains("grant access")));
    assert_eq!(discover(None, &home, |_| false).profiles.len(), 1);
    let denied = discover(Some(&project), &home, |path| {
        path != project_agents.join("review.agent.md")
    });
    assert_eq!(denied.profiles.len(), 2);
    assert!(denied
        .issues
        .iter()
        .any(|issue| issue.contains("grant access")));
    let linked_root = directory.join("linked-project");
    symlink(&project, &linked_root).unwrap();
    let linked = discover(Some(&linked_root), &home, |_| true);
    assert_eq!(linked.profiles.len(), 1);
    assert!(linked
        .issues
        .iter()
        .any(|issue| issue.contains("symbolic links")));
    fs::write(
        project_agents.join("oversized.md"),
        "x".repeat(MAX_FILE_BYTES as usize + 1),
    )
    .unwrap();
    let oversized = discover(Some(&project), &home, |_| true);
    assert!(oversized
        .issues
        .iter()
        .any(|issue| issue.contains("oversized.md") && issue.contains("256 KiB")));
    for index in 0..=MAX_FILES {
        fs::write(project_agents.join(format!("limit-{index}.md")), text).unwrap();
    }
    let limited = discover(Some(&project), &home, |_| true);
    assert!(limited
        .issues
        .iter()
        .any(|issue| issue.contains("256 files")));
    assert_eq!(
        limited.profiles.len(),
        1,
        "oversized project catalogues must not silently return a partial list"
    );
}

#[test]
fn directory_swaps_during_discovery_cannot_redirect_file_reads() {
    use std::{cell::Cell, os::unix::fs::symlink};
    let fixture = TestDirectory::new();
    let directory = &fixture.0;
    let project = directory.join("project");
    let home = directory.join("home");
    let nested = project.join(".github/agents/nested");
    let outside = directory.join("outside");
    fs::create_dir_all(&nested).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(
        nested.join("review.md"),
        "---\ndescription: Test\n---\nOriginal instructions.",
    )
    .unwrap();
    fs::write(
        outside.join("review.md"),
        "---\ndescription: Test\n---\nOutside instructions.",
    )
    .unwrap();
    let swapped = Cell::new(false);
    let catalogue = discover(Some(&project), &home, |path| {
        if path == nested.join("review.md") && !swapped.replace(true) {
            fs::rename(&nested, directory.join("original")).unwrap();
            symlink(&outside, &nested).unwrap();
        }
        true
    });
    assert!(
        swapped.get(),
        "The test must exercise the race, not just normal discovery"
    );
    assert!(!catalogue
        .profiles
        .iter()
        .any(|profile| profile.prompt == "Outside instructions."));
}
