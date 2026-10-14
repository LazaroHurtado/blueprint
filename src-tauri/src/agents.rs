use rustix::fs::{openat, statat, AtFlags, Dir, FileType, Mode, OFlags};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs::{self, File},
    io::{self, Read},
    os::unix::ffi::OsStrExt,
    path::{Component, Path, PathBuf},
};
use tauri::Manager;
use tauri_plugin_fs::FsExt;

type Result<T> = std::result::Result<T, String>;
const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_FILES: usize = 256;

#[derive(Deserialize)]
#[serde(untagged)]
enum Tools {
    List(Vec<String>),
    Text(String),
}

impl Default for Tools {
    fn default() -> Self {
        Self::List(all_tools())
    }
}

fn all_tools() -> Vec<String> {
    vec!["*".into()]
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum McpServer {
    #[serde(alias = "stdio")]
    Local {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default = "all_tools")]
        tools: Vec<String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        #[serde(default = "all_tools")]
        tools: Vec<String>,
    },
}

#[derive(Deserialize)]
struct Header {
    name: Option<String>,
    description: String,
    model: Option<String>,
    #[serde(default)]
    tools: Tools,
    #[serde(default, rename = "mcp-servers")]
    mcp_servers: BTreeMap<String, McpServer>,
    target: Option<String>,
    #[serde(default, flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    id: String,
    source: &'static str,
    file_name: String,
    name: String,
    description: String,
    prompt: String,
    model: Option<String>,
    tools: Vec<String>,
    mcp_servers: BTreeMap<String, McpServer>,
    warnings: Vec<String>,
}

#[derive(Default, Serialize)]
pub struct AgentCatalogue {
    profiles: Vec<AgentProfile>,
    issues: Vec<String>,
}

fn identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn secret_reference(value: &str) -> bool {
    if let Some(inner) = value
        .strip_prefix("${{")
        .and_then(|value| value.strip_suffix("}}"))
    {
        return inner
            .trim()
            .split_once('.')
            .is_some_and(|(kind, name)| matches!(kind, "secrets" | "vars") && identifier(name));
    }
    let inner = value
        .strip_prefix("${")
        .and_then(|value| value.strip_suffix('}'))
        .or_else(|| value.strip_prefix('$'));
    inner.is_some_and(identifier)
}

fn parse_profile(text: &str, file_name: String, source: &'static str) -> Result<AgentProfile> {
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let body = text
        .strip_prefix("---\n")
        .ok_or("Missing YAML frontmatter.")?;
    let (yaml, prompt) = body
        .split_once("\n---\n")
        .ok_or("Missing closing frontmatter delimiter.")?;
    let header: Header = serde_yaml_ng::from_str(yaml).map_err(|_| {
        "Invalid or unsupported YAML frontmatter. Check field types and MCP settings."
    })?;
    if header
        .target
        .as_deref()
        .is_some_and(|target| target != "github-copilot")
    {
        return Err("This profile targets an unsupported environment.".into());
    }
    let filename = file_name.rsplit('/').next().unwrap_or(&file_name);
    let fallback = filename
        .strip_suffix(".agent.md")
        .or_else(|| filename.strip_suffix(".md"))
        .unwrap_or(filename);
    let name = header
        .name
        .unwrap_or_else(|| fallback.into())
        .trim()
        .to_string();
    let prompt = prompt.trim().to_string();
    if name.is_empty() || name.encode_utf16().count() > 100 {
        return Err("Agent names must contain 1 to 100 characters.".into());
    }
    if header.description.trim().is_empty() || header.description.encode_utf16().count() > 2_000 {
        return Err("Descriptions must contain 1 to 2000 characters.".into());
    }
    if prompt.is_empty() || prompt.encode_utf16().count() > 30_000 {
        return Err("System prompts must contain 1 to 30000 characters.".into());
    }
    let model = header.model.map(|model| model.trim().to_string());
    if model
        .as_ref()
        .is_some_and(|model| model.is_empty() || model.encode_utf16().count() > 200)
    {
        return Err("Model IDs must contain 1 to 200 characters.".into());
    }
    for server in header.mcp_servers.values() {
        let values = match server {
            McpServer::Local { env, .. } => env,
            McpServer::Http { url, headers, .. } => {
                let url = tauri::Url::parse(url).map_err(|_| "Invalid MCP URL.")?;
                if !url.username().is_empty()
                    || url.password().is_some()
                    || !(url.scheme() == "https"
                        || (url.scheme() == "http"
                            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
                {
                    return Err(
                        "MCP URLs must use HTTPS or localhost HTTP, without credentials.".into(),
                    );
                }
                headers
            }
        };
        if !values.values().all(|value| secret_reference(value)) {
            return Err(
                "MCP environment/header values must be secret references, not credentials.".into(),
            );
        }
    }
    let tools = match header.tools {
        Tools::List(tools) => tools,
        Tools::Text(tools) => tools.split(',').map(str::to_string).collect(),
    };
    let tools = tools
        .into_iter()
        .map(|tool| tool.trim().to_string())
        .filter(|tool| !tool.is_empty())
        .collect();
    let warnings = if header.extra.is_empty() {
        Vec::new()
    } else {
        vec![format!(
            "Additional profile metadata is not imported: {}.",
            header.extra.keys().cloned().collect::<Vec<_>>().join(", ")
        )]
    };
    Ok(AgentProfile {
        id: format!("{source}:{file_name}"),
        source,
        file_name,
        name,
        description: header.description,
        prompt,
        model,
        tools,
        mcp_servers: header.mcp_servers,
        warnings,
    })
}

fn open_directory(parent: &File, name: &Path) -> io::Result<File> {
    openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(Into::into)
}

fn open_root(root: &Path) -> Result<(PathBuf, File)> {
    if !root.is_absolute()
        || root
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err("Choose an absolute project folder.".into());
    }
    let path = match (root.parent(), root.file_name()) {
        (Some(parent), Some(name)) => fs::canonicalize(parent)
            .map_err(|_| "Cannot resolve the agent folder's parent.")?
            .join(name),
        _ => root.to_path_buf(),
    };
    let mut directory = File::open("/").map_err(|_| "Cannot open the filesystem root.")?;
    // Pin every directory so renaming it or replacing it with a link cannot redirect reads.
    for component in path.components() {
        if let Component::Normal(name) = component {
            directory = open_directory(&directory, Path::new(name))
                .map_err(|_| "Cannot open the agent folder without following symbolic links.")?;
        }
    }
    Ok((path, directory))
}

fn scan(
    handle: &File,
    directory: &Path,
    base: &Path,
    source: &'static str,
    allowed: &impl Fn(&Path) -> bool,
    catalogue: &mut AgentCatalogue,
    files: &mut usize,
) -> Result<()> {
    let mut entries = Dir::read_from(handle)
        .map_err(|_| "Cannot list agent profiles. Check directory permissions.")?
        .filter(|entry| {
            !entry
                .as_ref()
                .is_ok_and(|entry| matches!(entry.file_name().to_bytes(), b"." | b".."))
        })
        .take(MAX_FILES + 1)
        .collect::<rustix::io::Result<Vec<_>>>()
        .map_err(|_| "Cannot read an agent directory entry.")?;
    if entries.len() > MAX_FILES {
        return Err("Agent discovery is limited to 256 files and directories per source.".into());
    }
    entries.sort_by(|left, right| left.file_name().cmp(right.file_name()));
    for entry in entries {
        // ponytail: bounded discovery, raise these limits if large agent libraries need it.
        if *files >= MAX_FILES {
            return Err(
                "Agent discovery is limited to 256 files and directories per source.".into(),
            );
        }
        *files += 1;
        let name = OsStr::from_bytes(entry.file_name().to_bytes());
        let path = directory.join(name);
        let relative = path.strip_prefix(base).map_err(|_| "Invalid agent path.")?;
        let result: Result<Option<File>> = (|| {
            if !allowed(&path) {
                return Err("Select this project's folder to grant access to its agents.".into());
            }
            let file_name = relative
                .to_str()
                .ok_or("Agent filenames must be valid UTF-8.")?;
            let info = statat(handle, name, AtFlags::SYMLINK_NOFOLLOW)
                .map_err(|_| "Cannot inspect this agent file.")?;
            let kind = FileType::from_raw_mode(info.st_mode);
            if kind == FileType::Symlink {
                return Err("Symbolic links are not read.".into());
            }
            if kind == FileType::Directory {
                let child = open_directory(handle, Path::new(name))
                    .map_err(|_| "Cannot read this directory without following symbolic links.")?;
                return Ok(Some(child));
            }
            if !file_name.ends_with(".md") {
                return Ok(None);
            }
            if kind != FileType::RegularFile {
                return Err("Agent profiles must be regular files.".into());
            }
            let file = File::from(
                openat(
                    handle,
                    name,
                    OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| "Cannot open this agent profile without following symbolic links.")?,
            );
            let info = file
                .metadata()
                .map_err(|_| "Cannot inspect the opened agent profile.")?;
            if !info.is_file() || info.len() > MAX_FILE_BYTES {
                return Err("Agent profiles must be regular files up to 256 KiB.".into());
            }
            let mut text = String::new();
            file.take(MAX_FILE_BYTES + 1)
                .read_to_string(&mut text)
                .map_err(|_| "Cannot read this agent profile as UTF-8.")?;
            if text.len() as u64 > MAX_FILE_BYTES {
                return Err("Agent profile exceeds 256 KiB.".into());
            }
            catalogue
                .profiles
                .push(parse_profile(&text, file_name.into(), source)?);
            Ok(None)
        })();
        match result {
            Ok(Some(child)) => scan(&child, &path, base, source, allowed, catalogue, files)?,
            Ok(None) => {}
            Err(error) => catalogue
                .issues
                .push(format!("{source}/{}: {error}", relative.display())),
        }
    }
    Ok(())
}

fn discover(root: Option<&Path>, home: &Path, allowed: impl Fn(&Path) -> bool) -> AgentCatalogue {
    let mut catalogue = AgentCatalogue::default();
    for (root, config, source) in root
        .into_iter()
        .map(|root| (root, ".github", "project"))
        .chain(std::iter::once((home, ".copilot", "personal")))
    {
        let mut source_catalogue = AgentCatalogue::default();
        let result = (|| {
            if source == "project" && !allowed(&root.join(config).join("agents")) {
                return Err(
                    "Choose the project folder with Browse to grant access to its agents.".into(),
                );
            }
            let (root, mut handle) = open_root(root)?;
            let directory = root.join(config).join("agents");
            if source == "project" && !allowed(&directory) {
                return Err("The resolved project folder is outside the granted scope.".into());
            }
            for name in [config, "agents"] {
                handle =
                    match open_directory(&handle, Path::new(name)) {
                        Ok(child) => child,
                        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                        Err(_) => return Err(
                            "Cannot read agent directories; check permissions and symbolic links."
                                .into(),
                        ),
                    };
            }
            scan(
                &handle,
                &directory,
                &directory,
                source,
                &|path| source == "personal" || allowed(path),
                &mut source_catalogue,
                &mut 0,
            )
        })();
        if let Err(error) = result {
            catalogue
                .issues
                .push(format!("{source}/{config}/agents: {error}"));
        } else {
            catalogue.profiles.extend(source_catalogue.profiles);
            catalogue.issues.extend(source_catalogue.issues);
        }
    }
    catalogue
}

#[tauri::command]
pub async fn discover_agents(
    app: tauri::AppHandle,
    root: Option<PathBuf>,
) -> Result<AgentCatalogue> {
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Cannot locate the user's home directory.")?;
    let scope = app.fs_scope();
    tauri::async_runtime::spawn_blocking(move || {
        discover(root.as_deref(), &home, |path| scope.is_allowed(path))
    })
    .await
    .map_err(|error| format!("Agent discovery failed: {error}"))
}

#[cfg(test)]
mod tests;
