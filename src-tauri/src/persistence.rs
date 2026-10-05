use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OutputFile {
    pub path: String,
    pub content: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    file: OutputFile,
    original: Option<String>,
    mode: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u8,
    id: String,
    root: PathBuf,
    entries: Vec<Entry>,
    started: usize,
    committed: bool,
}

#[derive(Serialize)]
pub struct SaveResult {
    pub saved: bool,
    pub recovered: Option<String>,
}

pub struct SaveStore {
    directory: PathBuf,
    _lock: File,
}

impl Drop for SaveStore {
    fn drop(&mut self) {
        // A concurrently spawned runtime can inherit the descriptor until exec.
        if let Err(error) = self._lock.unlock() {
            eprintln!("Blueprint: could not release the save lock: {error}");
        }
    }
}

fn at<T>(result: io::Result<T>, path: &Path) -> Result<T> {
    result.map_err(|error| format!("{}: {error}", path.display()))
}

fn sync_directory(path: &Path) -> Result<()> {
    at(File::open(path).and_then(|file| file.sync_all()), path)
}

fn metadata(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(info) if info.file_type().is_symlink() => {
            Err(format!("Refusing a symbolic link: {}", path.display()))
        }
        Ok(info) => Ok(Some(info)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

fn contents(path: &Path) -> Result<Option<String>> {
    match metadata(path)? {
        None => Ok(None),
        Some(info) if info.is_file() => at(fs::read_to_string(path), path).map(Some),
        Some(_) => Err(format!("Not a regular file: {}", path.display())),
    }
}

fn create_directories(path: &Path) -> Result<()> {
    match metadata(path)? {
        Some(info) if info.is_dir() => return Ok(()),
        Some(_) => return Err(format!("Not a directory: {}", path.display())),
        None => {}
    }
    let parent = path.parent().ok_or("Directory has no parent.")?;
    create_directories(parent)?;
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if !metadata(path)?.is_some_and(|info| info.is_dir()) {
                return Err(format!("Not a directory: {}", path.display()));
            }
        }
        Err(error) => return Err(format!("{}: {error}", path.display())),
    }
    sync_directory(parent)
}

fn validate_relative(path: &str) -> Result<()> {
    let parts: Vec<_> = path.split('/').collect();
    let supported = (parts.len() >= 3 && parts[0] == ".github")
        || (parts.len() == 1 && path.ends_with(".json"));
    if !supported
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || part.contains(['\\', '\0'])
                || part.starts_with(".blueprint-")
        })
        || Path::new(path)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(
            "Save paths must be a JSON draft or files inside the selected folder's .github directory.".into(),
        );
    }
    Ok(())
}

fn parent_directory(root: &Path, relative: &str, create: bool) -> Result<PathBuf> {
    let parent = Path::new(relative)
        .parent()
        .ok_or("An output file needs a parent directory.")?;
    let mut directory = root.to_path_buf();
    for part in parent.components() {
        let next = directory.join(part);
        match metadata(&next)? {
            Some(info) if !info.is_dir() => {
                return Err(format!("Not a directory: {}", next.display()));
            }
            None if create => {
                at(fs::create_dir(&next), &next)?;
                sync_directory(&directory)?;
            }
            _ => {}
        }
        directory = next;
    }
    Ok(directory)
}

fn create_file(path: &Path, text: &str, mode: u32) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = at(options.open(path), path)?;
    at(file.write_all(text.as_bytes()), path)?;
    #[cfg(unix)]
    at(file.set_permissions(fs::Permissions::from_mode(mode)), path)?;
    at(file.sync_all(), path)
}

fn remove_file(path: &Path) -> Result<()> {
    match metadata(path)? {
        Some(info) if info.is_file() => {
            at(fs::remove_file(path), path)?;
            sync_directory(path.parent().ok_or("File has no parent directory.")?)?;
        }
        Some(_) => return Err(format!("Not a regular file: {}", path.display())),
        None => {}
    }
    Ok(())
}

impl SaveStore {
    pub fn open(directory: PathBuf) -> Result<Self> {
        create_directories(&directory)?;
        if !metadata(&directory)?.is_some_and(|info| info.is_dir()) {
            return Err("The save recovery directory is invalid.".into());
        }
        #[cfg(unix)]
        at(
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)),
            &directory,
        )?;
        let lock_path = directory.join("save.lock");
        metadata(&lock_path)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        options.mode(0o600);
        let lock = at(options.open(&lock_path), &lock_path)?;
        // ponytail: one save per local user; per-destination locks if save throughput matters.
        lock.try_lock().map_err(|error| {
            format!("Another Blueprint save or recovery may be running. Retry when it finishes. {error}")
        })?;
        Ok(Self {
            directory,
            _lock: lock,
        })
    }

    fn journal_path(&self) -> PathBuf {
        self.directory.join("transaction.json")
    }

    fn store(&self, journal: &Journal) -> Result<()> {
        let next = self.directory.join("transaction.next");
        remove_file(&next)?;
        let text = serde_json::to_string(journal).map_err(|error| error.to_string())?;
        create_file(&next, &text, 0o600)?;
        at(fs::rename(&next, self.journal_path()), &self.directory)?;
        sync_directory(&self.directory)
    }

    fn load(&self) -> Result<Option<Journal>> {
        let Some(text) = contents(&self.journal_path())? else {
            remove_file(&self.directory.join("transaction.next"))?;
            return Ok(None);
        };
        let journal: Journal = serde_json::from_str(&text).map_err(|error| {
            format!(
                "Recovery journal is unreadable; preserve {}. {error}",
                self.journal_path().display()
            )
        })?;
        if journal.version != 1
            || journal.started > journal.entries.len()
            || (journal.committed && journal.started != journal.entries.len())
            || journal.id.is_empty()
            || journal.id.len() > 64
            || !journal
                .id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
            || !journal.root.is_absolute()
        {
            return Err(format!(
                "Invalid recovery journal: {}",
                self.journal_path().display()
            ));
        }
        if at(fs::canonicalize(&journal.root), &journal.root)? != journal.root {
            return Err("The recovery destination moved or became a symbolic link.".into());
        }
        let mut paths = HashSet::new();
        for entry in &journal.entries {
            validate_relative(&entry.file.path)?;
            if !paths.insert(entry.file.path.to_lowercase()) {
                return Err("Duplicate paths in the recovery journal.".into());
            }
        }
        Ok(Some(journal))
    }

    fn temporary(journal: &Journal, index: usize) -> PathBuf {
        journal
            .root
            .join(&journal.entries[index].file.path)
            .with_file_name(format!(".blueprint-{}-{index}.tmp", journal.id))
    }

    fn replace(&self, journal: &Journal, index: usize, text: &str, new_file: bool) -> Result<()> {
        let entry = &journal.entries[index];
        let parent = parent_directory(&journal.root, &entry.file.path, true)?;
        let target = journal.root.join(&entry.file.path);
        let temporary = Self::temporary(journal, index);
        create_file(&temporary, text, entry.mode)?;
        if new_file {
            // A concurrently created file must not be replaced after an absence check.
            at(fs::hard_link(&temporary, &target), &target)?;
            at(fs::remove_file(&temporary), &temporary)?;
        } else {
            at(fs::rename(&temporary, &target), &target)?;
        }
        sync_directory(&parent)
    }

    fn clear(&self) -> Result<()> {
        remove_file(&self.journal_path())?;
        remove_file(&self.directory.join("transaction.next"))
    }

    pub fn recover(&self) -> Result<Option<String>> {
        let Some(journal) = self.load()? else {
            return Ok(None);
        };
        let mut conflicts = Vec::new();
        for index in (0..journal.started).rev() {
            let entry = &journal.entries[index];
            let result = (|| {
                parent_directory(&journal.root, &entry.file.path, false)?;
                let target = journal.root.join(&entry.file.path);
                let current = contents(&target)?;
                remove_file(&Self::temporary(&journal, index))?;
                if journal.committed || current == entry.original {
                    return Ok(());
                }
                if current.as_ref() != Some(&entry.file.content) {
                    return Err(format!(
                        "External changes at {}; restore this file manually from the recovery journal.",
                        target.display()
                    ));
                }
                match &entry.original {
                    Some(original) => self.replace(&journal, index, original, false),
                    None => remove_file(&target),
                }
            })();
            if let Err(error) = result {
                conflicts.push(error);
            }
        }
        if !conflicts.is_empty() {
            return Err(format!(
                "Recovery needs attention. Original files remain in {}.\n{}",
                self.journal_path().display(),
                conflicts.join("\n")
            ));
        }
        self.clear()?;
        Ok(Some(if journal.committed {
            format!(
                "Finished cleanup of a completed save in {}.",
                journal.root.display()
            )
        } else {
            format!(
                "Restored the previous export in {} after an interrupted save.",
                journal.root.display()
            )
        }))
    }

    fn prepare(
        &self,
        root: &Path,
        files: Vec<OutputFile>,
        allowed: impl Fn(&Path) -> bool,
        confirm: impl FnOnce(&[PathBuf]) -> bool,
    ) -> Result<Option<Journal>> {
        let root = at(fs::canonicalize(root), root)?;
        if files.is_empty() || !root.is_dir() {
            return Err("Choose an existing export folder and at least one output file.".into());
        }
        let mut paths = HashSet::new();
        let mut entries = Vec::new();
        let mut conflicts = Vec::new();
        let recovery_root = at(fs::canonicalize(&self.directory), &self.directory)?;
        for file in files {
            validate_relative(&file.path)?;
            if !paths.insert(file.path.to_lowercase()) {
                return Err("Export contains case-insensitive duplicate paths.".into());
            }
            parent_directory(&root, &file.path, false)?;
            let target = root.join(&file.path);
            if target.starts_with(&recovery_root) {
                return Err("Cannot save a document inside Blueprint's recovery directory.".into());
            }
            if !allowed(&target) {
                return Err(format!(
                    "Select the export folder with Browse before writing {}.",
                    target.display()
                ));
            }
            let original = contents(&target)?;
            let mut mode = 0o644;
            if original.is_some() {
                conflicts.push(target.clone());
                #[cfg(unix)]
                {
                    mode = at(fs::metadata(&target), &target)?.permissions().mode() & 0o777;
                }
            }
            entries.push(Entry {
                file,
                original,
                mode,
            });
        }
        if !conflicts.is_empty() && !confirm(&conflicts) {
            return Ok(None);
        }
        let id = format!(
            "{:x}-{:x}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_nanos()
        );
        let journal = Journal {
            version: 1,
            id,
            root,
            entries,
            started: 0,
            committed: false,
        };
        self.store(&journal)?;
        Ok(Some(journal))
    }

    fn install(&self, journal: &mut Journal, index: usize) -> Result<()> {
        let entry = &journal.entries[index];
        parent_directory(&journal.root, &entry.file.path, false)?;
        let target = journal.root.join(&entry.file.path);
        if contents(&target)? != entry.original {
            return Err(format!(
                "A file changed during export: {}. Review it and retry.",
                target.display()
            ));
        }
        journal.started = index + 1;
        self.store(journal)?;
        self.replace(
            journal,
            index,
            &journal.entries[index].file.content,
            entry.original.is_none(),
        )
    }

    pub fn save(
        &self,
        root: &Path,
        files: Vec<OutputFile>,
        allowed: impl Fn(&Path) -> bool,
        confirm: impl FnOnce(&[PathBuf]) -> bool,
    ) -> Result<SaveResult> {
        let recovered = self.recover()?;
        let Some(mut journal) = self.prepare(root, files, allowed, confirm)? else {
            return Ok(SaveResult {
                saved: false,
                recovered,
            });
        };
        let result = (|| {
            for index in 0..journal.entries.len() {
                self.install(&mut journal, index)?;
            }
            journal.committed = true;
            self.store(&journal)
        })();
        if let Err(error) = result {
            return Err(match self.recover() {
                Ok(recovered) => format!(
                    "{error}{}",
                    recovered
                        .map(|message| format!("\n{message}"))
                        .unwrap_or_default()
                ),
                Err(recovery) => format!("{error}\n{recovery}"),
            });
        }
        self.clear().map_err(|error| {
            format!("Files were saved, but recovery cleanup is pending: {error}")
        })?;
        Ok(SaveResult {
            saved: true,
            recovered,
        })
    }
}

#[cfg(test)]
mod tests;
