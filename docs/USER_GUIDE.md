# User guide

A local, minimal visual editor for GitHub Copilot dynamic workflows. Built with
Tauri, React, TypeScript, React Flow, and Zod for Ubuntu and macOS.

Start with the [project overview](../README.md) and
[development setup](DEVELOPING.md). Known issues and verification limits are tracked in
[ISSUES.md](ISSUES.md). Branch joins follow the rules below; unsupported
combinations are rejected rather than assigned guessed execution behavior.

## Run

Install Node.js 24+, Rust 1.94+, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.
On macOS, desktop development requires Xcode Command Line Tools. On Ubuntu,
install the GTK/WebKit development packages listed in that guide.
`rust-toolchain.toml` selects Rust 1.94.0 for this project without changing your
global toolchain.

```sh
npm ci
npm run tauri dev
```

`npm run dev` serves a browser preview at `http://localhost:1420`. Editing and
JSON import work in the preview; native file/folder selection, saving, and Copilot
connection require the desktop app.

## Design a workflow

1. Create a workflow, or open a saved `blueprint.json` document.
2. Click or drag Agent, Decision, or Loop from the floating top toolbar. Select a node to
   edit it. Node placement, connections, and deletion also have button/form
   alternatives to dragging.
3. Connect output handles to input handles. Connect mode also offers Use form
   for keyboard-friendly creation and removal of connections.
4. Configure agent models, system prompts, task prompts, tools, MCP servers, and output
   fields. JSON outputs support text, numbers, booleans, arrays, and objects.
5. Use the Save icon after the toolbar's vertical divider to save a draft file
   or generate a repository export.

The editor contains a full-viewport canvas, a centered floating top toolbar, and
a workflow-name card in the top-left. The name card supports inline renaming and
back navigation to the welcome screen. The left inspector appears only when a
single block is selected; click the canvas, its close button, or Escape to hide it.
Adding a block leaves it unselected until you select it. The inspector is at most
720 px tall and shrinks to fit smaller windows without covering the top controls.

The canvas can be panned and zoomed. Delete/Backspace removes selected nodes or
connections; Escape dismisses the inspector or cancels connection mode; Ctrl/Cmd+S
opens the save dialog, including for incomplete workflows. Unsaved changes require confirmation before closing
the desktop window or returning to the welcome screen.

Each agent has an optional Model field accepting a Copilot model ID. Select
Default, or leave a manual ID blank, to inherit Copilot's configured default;
existing documents without a model continue to inherit that default.
A chosen model is saved in `blueprint.json` and
included in both the workflow's `ctx.agent` options and agent Markdown frontmatter,
including agents inside loops. Clearing the field removes the override.
Model availability is checked by Copilot when the workflow runs, based on the
runner's account, providers, and policies; Blueprint does not hardcode a model list.

## Copilot-assisted authoring

Copilot login is optional. Workflow creation, manual editing, import, draft saving,
and repository export remain local and work without signing in.

### Connect an account

Use **Login with Copilot** on the welcome screen or **Login** in an agent's
inspector. Blueprint reuses a usable existing Copilot login when available;
otherwise, sign in to GitHub.com through your system browser. The bundled runtime
handles the OAuth loopback/PKCE flow, cancellation, and credential persistence.
The browser can be reopened from the waiting dialog. Organization policy and
Copilot entitlement still govern access to models and generation.

Credentials stay behind the native boundary. They are not returned to the
renderer, saved in browser storage, or added to workflow documents. Copilot owns
credential storage, normally through macOS Keychain or Linux Secret Service.
Blueprint refuses a new plaintext-storage consent request and reports how to
enable/unlock a keychain. Existing Copilot credential-storage preferences still
apply; Blueprint does not migrate or erase credentials saved by another app.
Environment token overrides are removed from the Blueprint-owned runtime so they
do not unexpectedly override an interactive account.

**Account** offers refresh and **Disconnect**. Disconnect is a persistent
Blueprint-only preference: it stops Blueprint's runtime but does not sign out of
Copilot CLI or delete its credentials. Refresh restarts the connection and reloads
account/model metadata. Additional enterprise-specific sign-in setup can be done
in Copilot CLI before reconnecting Blueprint.

### Choose an agent model

When connected, the Model field is a native, keyboard-accessible dropdown populated
from the account's runtime catalog. It includes Default, policy explanations,
service notices for the selected model, and **Enter a model ID**. Disabled models
cannot be selected from the account list.

Unavailable imported IDs are retained, not replaced with the first available
model. Catalog errors leave manual entry available. When disconnected, the same
field is an ordinary optional text input. These settings describe the exported
agent; another person running the workflow may have different model access.

### Generate a system prompt

Click **Generate** beside an agent's system prompt, describe what it should do,
then choose **Generate prompt**. This explicitly sends a request using your
Copilot allowance. Drafting uses the Copilot runtime's default model, independently
of the model saved on the workflow agent.

Only the description, agent name, tool names, output format, and JSON field
definitions are sent. Blueprint does not send the existing system prompt, task
prompt, MCP configuration, workflow graph, or repository files. The native SDK
session uses Empty mode, an empty tool allowlist, deny-all permissions, no MCP
servers, and no configuration/instruction/skill/extension discovery. It runs in
an app-local workspace rather than the project being edited.

Review and edit the proposed text before **Apply prompt**. Applying changes only
the original agent's system prompt, including inside loop bodies; it preserves
its model, tools, task, and output settings. Cancel never applies a draft.
Connection errors retain the description. **Check Copilot connection** opens the
account dialog above the prompt editor, so refreshing or signing in again does
not discard the request. Save shortcuts and native close confirmation also
preserve an open prompt/model draft.

Descriptions are limited to 10,000 characters and generated prompts to 30,000.
Only one login or generation action runs at a time per Blueprint instance.
Cancellation requests stop the active turn; runtime/cleanup failures are reported,
and a completed draft is retained with a warning if cleanup fails. Normal
generation sessions are deleted after use. The SDK maintains its own local state;
a process crash or cleanup failure may leave temporary session data.

### Runtime and distribution

The native integration pins `github-copilot-sdk` **1.0.16**, which bundles Copilot
runtime **1.0.90**. Authentication/model RPCs are experimental, so upgrade the SDK
and its matching runtime together. No Node sidecar, hosted backend, or separate CLI
installation is needed for these authoring features. The first native build
downloads the SDK's checksum-verified, platform-specific runtime; the app extracts
it to the SDK's user cache on first use. Native artifacts are consequently larger
than the original canvas-only application.

Running exported workflows is separate: install/use Copilot CLI in the target
repository as described below. Saving or generating a prompt never runs the graph.

## Drafts and runnable exports

The existing Save dialog has two choices:

- **Draft file:** saves a standalone `.blueprint.json` document using the native
  file picker. It preserves unfinished prompts, connections, names, loop settings,
  and numeric condition fields. It does not create or modify runnable files.
- **Repository export:** writes the extension, TypeScript, editable document, and
  agent profiles under `.github`. The entire workflow must pass validation.

Incomplete graphs open Draft file by default; valid graphs keep Repository export
as the default. Both choices use the same native writer lock, overwrite approval,
and restart-time recovery. A draft can be reopened with Open existing workflow,
completed, and exported later.

Draft files use a versioned `blueprint-draft` envelope around the workflow. A list
of unfinished numeric conditions preserves the difference between an empty numeric
input and an intentional JSON `null`. Existing plain `blueprint.json` exports
remain supported and keep their original format. Draft saving is explicit; edits
made after the last save are not automatically recovered.

## Decisions and loops

Connections define dependencies. Independent roots can run concurrently; each
node awaits its incoming dependencies. A decision evaluates a typed field from
workflow inputs or an earlier JSON output. Both True and False paths must be
connected. Decisions carry their upstream payload forward rather than replacing
it with a boolean. Missing fields, incompatible values, and failed agents
produce explicit errors.

### Branch joins

Blueprint traces the decision branches governing each node before export.
There are no additional join settings:

- **Independent inputs are all required.** Research and Read logs feeding Report
  means Report waits for both and receives both outputs.
- **A branch is a gate, not just another input.** When True and Shared preparation
  both feed Fix, Fix requires the True branch *and* preparation. Preparation
  cannot activate Fix if False was selected. This also applies farther down
  that gated path.
- **Opposite paths from the same decision are alternatives.** True → Fix → Summary
  and False → Summary let Summary run once on the selected path. Shared inputs
  into Summary remain required. Multiple tasks on the chosen branch must all
  finish; an agent failure is never treated as an intentionally skipped branch.
- **Nested decisions rejoin inside-out.** Finish an inner True/False merge before
  rejoining the outer decision. Loops analyze their body graphs independently.

Inputs from unrelated decisions, or an outer merge reached through an unmerged
inner branch, are ambiguous. Validation names the affected node/decisions and
blocks executable export. Merge those branches first or express a combined
condition explicitly. Blueprint does not infer whether unrelated approvals mean
"either" or "both."

The document format and canvas controls are unchanged. Existing runnable exports
must be regenerated to receive the corrected activation logic.

### Loop bodies

Each loop owns a separate body graph. Edit body opens that canvas. Connections
cannot cross body boundaries, and arbitrary cycles are rejected.

- **Repeat:** runs the body at least once, checks its stop condition, and repeats
  up to the user-defined maximum. Body inputs include `previous` results,
  `index`, and the loop's `upstream` inputs. Exhausting the limit is an error,
  not successful completion.
- **For each:** reads an array field, processes items sequentially, and collects
  results in input order. Inputs include the configured item variable, `index`,
  and `upstream`. An empty array returns an empty result collection.

Nested loops are supported. Generated invocation labels include node IDs and
iteration paths so separate iterations do not accidentally reuse memoized agent
results, while labels remain stable for Copilot's resume behavior.

Agent fields are declared in the output editor. Loop fields are selectable by
readable body-node names without entering node IDs. Loop outputs contain
`iterations`/`results` for Repeat or `items` for For each; array counts are also
selectable. Workflow input references use dot-separated paths into the JSON
arguments supplied by the person running the exported workflow.

## Export

```text
.github/
  extensions/<workflow-name>/
    blueprint.json
    extension.mjs
    workflow.ts
  agents/
    <workflow-and-node-id>.agent.md
```

`blueprint.json` is the editable source of truth. `extension.mjs` is the runnable
entry point Copilot discovers. `workflow.ts` is the typed source equivalent;
compile it as an ES module if you choose to modify it outside Blueprint.
Opening arbitrary TypeScript or agent Markdown as a canvas is not supported.

Exports contain every agent, including those in nested loop bodies. Agent
profiles use workflow-prefixed stable names to avoid name collisions. Existing
files require replacement approval. The native save engine holds an OS-backed
lock across confirmation and writing, so only one Blueprint save/recovery can run
per local user. Other instances report that a save is busy rather than write concurrently.

Before changing a target, Blueprint durably records its original and new text
in a private recovery journal and flushes files/directories. Each target is
replaced atomically; new files use a no-clobber install. On startup and before
another save, an uncommitted journal rolls back the previous export. A durable
commit marker keeps a completed export and only finishes cleanup.

If recovery sees external edits, it preserves them, reports the journal location,
and blocks additional saves until the conflict is resolved. The lock coordinates
Blueprint instances, not unrelated editors. Multi-file exports are not an atomic
snapshot for readers; use a local filesystem supporting atomic renames, hard links,
and file locking. Durability assumes that the filesystem honors syncing.
Unrelated files are not removed. Read [BP-002](ISSUES.md#bp-002-export-recovery-covers-exceptions-not-process-crashes)
for the recovery contract and verification coverage.

Exports refuse symlink directories/targets. Native pickers grant the filesystem
scope, and the save command checks every destination against that scope. The
renderer cannot perform its own write/rename/delete operations. Dotfile matching
is allowed only inside the granted scope because exports live under `.github`.

MCP environment/header values must be references such as `${TOKEN}` or
`${{ secrets.COPILOT_MCP_TOKEN }}`, not credential values. Provide the credentials
and MCP executables in the Copilot environment separately; do not put credentials
in prompts, URLs, or command arguments.
The MCP editor's allowed server tools are also included in the agent's tool
allowlist. Existing imported restrictions are preserved rather than widened.

After exporting, trust/load the project extension in Copilot CLI and enable its
experimental features. Authenticate and grant the required permissions before
running:

```sh
copilot --experimental workflow run <workflow-name> \
  --args '{"task":"Review the changes","files":["src/example.ts"]}' \
  --allow-tool=read
```

Replace the inputs and permissions to suit the workflow. Saving in Blueprint
does **not** start a Copilot run. The dynamic-workflows API is experimental;
exports are checked against the SDK version pinned in `package-lock.json`.
The Node Copilot SDK remains a **development-only** dependency for exporter
contract checks; it is not shipped in the frontend. The separate Rust SDK and
bundled runtime power the optional Copilot authoring features above.

## Build and checks

```sh
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
npm run build
npm run notices
npm run tauri build -- --bundles deb -- --locked
```

The checks use Node's built-in runner, the actual SDK registration/types, and
stub agent responses; they do not consume Copilot credits. They cover branching,
data handoffs, loops, cancellation, malformed imports, generated TypeScript,
draft persistence, and the native command bridge. Rust tests exercise actual filesystem staging,
rollback, cross-process locking, and abrupt child-process exits before/after
commit and during recovery.
Copilot checks cover IPC payload minimization, model-policy metadata, explicit
apply/cancel behavior, input/output bounds, denied tools, and a real bundled-runtime
startup with isolated credentials. The runtime check prepares and cancels a browser
login without opening a browser, signing in, or making an inference request.

The mixed-join regression [BP-001](ISSUES.md#bp-001-mixed-joins-can-bypass-a-decision-gate)
is now an ordinary passing check, alongside complementary joins, shared inputs,
nested decisions, and rejection of ambiguous branch combinations.

To produce only an Ubuntu Debian package:

```sh
npm run package -- --bundles deb -- --locked
```

Build macOS bundles on macOS; signing/notarization credentials are needed for
public distribution. Native artifacts are under `src-tauri/target/release`.
No database, web backend, or cloud account is required to design workflows.
See [release preparation](RELEASING.md) for notice-tool installation, candidate
packaging, signing, and the checks required before publishing a binary.
