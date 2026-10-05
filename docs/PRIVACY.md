# Privacy and data handling

This document describes Blueprint's own behavior, not a replacement for GitHub's
or a model provider's service terms. Blueprint has no hosted backend, account
database, advertising integration, or app-owned analytics endpoint.

## Local workflow data

Canvas state and unapplied prompt drafts are held in memory until explicitly
saved/applied. Saved drafts and exports contain the user-authored graph, prompts,
model IDs, tool names, and MCP configuration. They can be confidential even when
they contain no credential values. There is no continuous crash autosave.

Native picker scopes limit document reads and export/draft writes. The renderer
does not have general-purpose filesystem write permissions.

To recover interrupted saves, Blueprint keeps a private journal containing
**original and replacement file text**. Its app-local data directory is selected
by Tauri using the application identifier `dev.blueprint.desktop`, typically:

- Ubuntu: `$XDG_DATA_HOME/dev.blueprint.desktop`, or
  `~/.local/share/dev.blueprint.desktop` when that variable is unset.
- macOS: `~/Library/Application Support/dev.blueprint.desktop`.

The `save-recovery/` subdirectory contains `save.lock` and, while a transaction
needs recovery, journal files. Do not upload those files or remove a pending
journal to bypass a recovery conflict. Finish recovery or preserve a private
backup and resolve the conflict first.

## When network access can happen

Desktop startup can start the bundled Copilot runtime, inspect an existing login,
and fetch account/model metadata. This happens asynchronously and does not block
manual authoring, but it means "login is optional" is **not** a promise of zero
network traffic before the Login button is pressed.

**Disconnect** stores a local opt-out marker, stops Blueprint's runtime, and
suppresses these connection attempts until reconnecting. It does not revoke
GitHub credentials or sign out other applications. For strict network isolation,
apply appropriate OS/network controls as well.

Browser OAuth uses GitHub's authorization endpoint and a runtime-managed local
loopback callback. Do not share raw authorization URLs. Blueprint receives only
credential-free account metadata in the renderer. Copilot owns credential storage,
normally in the OS keychain; its existing storage preferences still apply.
Blueprint does not consent to a new plaintext-storage fallback.

## Prompt generation

Only choosing **Generate prompt** submits an inference request. Blueprint sends:

- The description entered for this request.
- The selected agent's name and tool names.
- Its output format and JSON field names/types.

It does not include the existing system prompt, task prompt, repository files,
MCP commands/environment/header configuration, or the complete workflow graph.
Do not put secrets in the description or these fields.

The drafting session uses an app-local working directory, no offered tools,
deny-all permissions, no MCP servers, and disabled ambient
configuration/instruction/skill/extension discovery. The model writes proposed
text; it does not edit the workflow. The user reviews and explicitly applies it.
Requests consume the user's Copilot allowance and are subject to the account's
organization policy and GitHub/model-provider data terms.

Blueprint disables SDK session telemetry for its drafting/control sessions, but
does not claim to disable all upstream runtime telemetry, logging, billing
records, or service-side retention. See
[GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
and the terms applicable to your Copilot account.

The SDK maintains its own local cache/config/session state. Generation sessions
are normally deleted after use; a crash or cleanup failure can leave temporary
state. Blueprint's empty `copilot-workspace/` and opt-out marker also live in its
app-local directory. The runtime binary cache is managed by the SDK.

## Diagnostics, examples, and deletion

Use synthetic workflows when reporting bugs. Review screenshots, logs, exports,
model-service messages, and file paths before sharing them. Never post tokens,
raw OAuth URLs, MCP secrets, recovery journals, or private source code.

Delete saved drafts/exports from the locations you selected when no longer
needed. Removing Blueprint's app-local directory removes its preferences and
recovery data, so only do so after resolving pending saves and making any needed
private backups. Uninstalling the app does not automatically erase GitHub
credentials, SDK caches, or files saved outside the application directory.

For connection problems, use **Account → Refresh account and models**. The prompt
error dialog can open that account panel without discarding the request. Resolve
entitlement/policy/keychain problems through the relevant administrator or Copilot
setup rather than posting credentials in an issue.
