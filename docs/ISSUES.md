# Blueprint verification and issue ledger

Reviewed on 2026-10-04. The substantial defects below have been resolved.
Public-release preparation and remaining maintainer gates are described in
[RELEASING.md](RELEASING.md). Remaining platform and
integration verification boundaries are listed separately; passing local checks
are not a claim of untested macOS or live Copilot behavior.

## Open substantial issues

The code defects BP-001 through BP-010 are resolved. **Public binary release is
not cleared:** GitHub repository settings, actual cross-platform CI/runtime
evidence, real-account Copilot testing, redistribution review, and macOS
signing/notarization remain maintainer gates. See the
[release checklist](RELEASING.md#release-gates), and keep the verification limits
below when evaluating readiness for distribution.

## Issue details

### BP-001: mixed joins can bypass a decision gate

**Status: fixed.** `planGraph` in `src/workflow.ts` now traces branch ancestry.
`src/export.ts` emits a node-specific activation expression instead of accepting
any active incoming edge. No new graph settings or document migration are needed.

Reproduction:

1. Connect Review to a Decision that reads its boolean `passed` output.
2. Connect True to Fix, False to Summary, and Fix to Summary.
3. Add an independent Shared agent and another connection from Shared to Fix.
4. Return `{ "passed": false }` from Review.

**Previous result:** Shared activated Fix even when the decision selected False.
**Corrected result:** Fix is skipped, and Summary receives only the chosen path.

Approved rules:

- Unconditional/shared prerequisites are required; they cannot bypass a gate.
- Complementary True/False paths from one decision merge as alternatives.
- Multiple tasks on the same selected branch are all required.
- Nested decision merges must close inner decisions before outer decisions.
- Unrelated conditional inputs and incomplete nested merges are rejected with
  an actionable validation error. No ambiguous OR/AND behavior is guessed.
- Skipped branches are distinct from failed agents. Failures still abort.

**Evidence:** the former TODO and the new shared-input, parallel-branch, nested
decision, loop-scope, ambiguity, and SDK-type regressions pass. The behavior is
documented in [User guide: Branch joins](USER_GUIDE.md#branch-joins).
Regenerate existing `extension.mjs` exports to apply this fix.

### BP-002: export recovery covers exceptions, not process crashes

**Status: fixed with the approved rollback policy.** File writes now route through
`src-tauri/src/persistence.rs`, not renderer-side write/rename calls.

- One OS-backed file lock per local user coordinates all Blueprint saves,
  including replacement confirmation and recovery. A crashed process releases
  the lock automatically; the persistent lock file is never deleted.
- A private `save-recovery/transaction.json` in the app's local data directory
  records the canonical destination, original/new text, permissions, and durable
  progress before any replacement. Journal files are owner-only.
- Files and directories are synced. Targets are atomically replaced; an absent
  target uses a no-clobber hard-link installation instead of overwriting a file
  that appeared after the absence check.
- App startup and every save recover a pending journal before continuing.
  Uncommitted writes roll back; completed commits keep the new files.
  Recovery is repeatable even when recovery itself is interrupted.
- Unexpected external edits are preserved. The error identifies the recovery
  journal containing the original text. Resolve the conflict (restore the
  original or the recorded new content), then retry recovery/relaunch. New saves
  remain blocked while the journal needs attention. Reconnect a missing drive
  or restore its path before recovering it.
- Native commands verify picker-granted destination scope. Renderer write,
  rename, and delete permissions were removed.

**Evidence:** native filesystem tests exercise original/new files, overwrite
cancellation, permission preservation, scope/symlink refusal, external edits,
concurrent processes, and abrupt process exits after preparation, write intent,
partial staging, individual installs, commit, and partial rollback.

**Boundary:** the lock coordinates Blueprint processes using the same local app
data directory, not arbitrary third-party writers. Conflicts observed before
replacement/recovery fail safely, but unrelated writers must coordinate their
own edits. This is recoverable multi-file saving, not an atomic snapshot for
external readers. Power-loss guarantees depend on the filesystem/hardware honoring
sync requests; physical power-cut tests and native macOS execution remain unverified.

### BP-003: no draft-only save

**Status: fixed with the approved two-mode Save dialog.**

- The existing Save icon and Ctrl/Cmd+S work for incomplete graphs.
- Draft file is the default for incomplete workflows; valid workflows retain
  Repository export as the default.
- Drafts are standalone `.blueprint.json` files. Saving one does not overwrite
  an existing runnable extension or its agent profiles.
- The native file picker grants only the chosen target. Drafts use the same
  lock, journal, overwrite protection, and rollback engine as repository exports.
- A versioned draft envelope preserves incomplete settings and numeric inputs
  without silently turning an empty numeric field into an intentional null.
  Old exported documents still open; executable export validation remains strict.
- The minimal toolbar is unchanged. The draft/export distinction is inside the
  existing dialog and is also reflected in Figma.

**Evidence:** draft round-trip and command-bridge checks cover empty prompts,
unconnected decisions, invalid iteration counts, nested models, numeric
placeholders, old documents, and conversion of completed drafts into exports.
Native tests cover exact-file scope and draft rollback without changing runnable files.
Drafts are explicitly saved, not continuous autosave; unsaved edits still require
the ordinary close/navigation warning.

## Substantial defects fixed during this review

| ID | Priority | Previous behavior | Fix and evidence |
| --- | --- | --- | --- |
| BP-001 | High | A shared prerequisite could activate an unchosen decision branch. | Branch-aware planning requires independent inputs, recognizes only complementary merges, and rejects ambiguous branch combinations. All related regressions pass; see above. |
| BP-002 | High | Exports lacked durable recovery and cross-process writer coordination. | Native journaling, synced atomic replacements, an OS-backed lock, and restart-time rollback now handle interrupted saves. Real process-exit/locking regressions pass; see the remaining platform boundaries above. |
| BP-003 | Medium | Incomplete workflows could not be persisted. | The Save dialog now supports standalone drafts without weakening runnable-export validation. Draft and export persistence regressions pass. |
| BP-004 | High | Ctrl/Cmd+S replaced the Tools & MCP dialog and discarded its draft. A native close confirmation could also unmount that draft before “Keep editing.” | Save shortcuts do not replace active dialogs. Discard confirmation is a separate modal, leaving tools mounted; browser unload/native close also considers open tools. Verified through UI interactions and Tauri's mocked close-event bridge. |
| BP-005 | Medium | Typing `lookup, write` into Allowed server tools produced `lookupwrite`: every keystroke removed the separator. | Preserve the raw editing list; trim, deduplicate, and remove empty entries when parsing the configuration. Typed-input UI regression and `mcpSchema` regression pass. |
| BP-006 | Medium | Typing a negative condition such as `-1.5` could produce positive `1.5`; unfinished numeric values could serialize as JSON `null`. | Use the input's numeric value without coercing blank text to zero. Reject non-finite condition values before serialization. UI typing and generated-export regressions pass. |
| BP-007 | High | A file modified while overwrite confirmation was open was silently replaced. | Native snapshots are compared before each install. On conflict, earlier writes are rolled back while external edits and recovery originals are preserved. Native filesystem regressions pass; third-party writers are outside the advisory lock. |
| BP-008 | Medium | Imported node IDs such as `Review` and `review` produced colliding agent filenames on default case-insensitive macOS filesystems. | Reject case-insensitive duplicate IDs at import/validation before generating files. Cross-platform path-contract regression passes; this is not a claim of native macOS execution. |
| BP-009 | Medium | Spawning the new Copilot runtime in parallel with saves could briefly retain an inherited lock descriptor, making an immediate subsequent save/recovery report a false busy condition. | `SaveStore` explicitly unlocks on drop rather than waiting for every inherited descriptor to close at exec. A deterministic duplicate-descriptor regression and parallel native suite cover release and existing cross-process exclusion. |
| BP-010 | High (distribution) | The private-development installer bundled Copilot and other dependencies without a complete accompanying notice set. | Source/upstream licenses, generated npm/native notices, a stale-notice packaging gate, bundled resource inclusion, and candidate artifact checks now prepare notice-bearing distributions. Maintainers must still review upstream redistribution/source-availability obligations before publication. |

## Copilot-assisted authoring

The approved optional login, account model dropdown/manual fallback, and
generate/preview/apply flow are implemented. The native integration pins Rust SDK
1.0.16 and its bundled runtime 1.0.90; it does not use a Node sidecar or web backend.
The existing workflow schema and generated model overrides are unchanged.

- Authentication credentials do not cross IPC. Browser URLs must use GitHub's
  HTTPS authorization endpoint, and the SDK owns the OAuth flow. Blueprint refuses
  new plaintext-storage consent requests; existing Copilot storage preferences
  still apply. Disconnect only opts Blueprint out and stops its runtime.
- Drafting sessions have no offered tools, deny all permissions, disable ambient
  configuration/instructions/skills/extensions, and do not start agent MCP servers.
  Only the description and minimal agent settings are submitted. Generation also
  verifies that the fresh drafting session has the same account identity as the
  connected control session before sending the description.
- Default and unknown saved model IDs are preserved through account changes,
  catalog errors, manual editing, generation, saving, reopening, and nested loops.
- Prompt requests and previews survive Ctrl/Cmd+S, native close/Keep editing, and
  a nested account refresh/re-login dialog. Only Apply mutates the original agent.
- The actual bundled runtime starts under isolated credentials, reports no
  authenticated account, excludes shell tools, and prepares/cancels a browser login
  without opening it. These checks do not consume inference allowance.
- Browser UI checks use controlled Tauri IPC responses for successful/failed
  generation, cancellation, account changes, model policies, and saved documents.
  Completed OAuth with a real account, paid inference, real account-specific model
  availability, native keychain behavior, and macOS execution remain unverified.
  No claim of end-to-end authenticated execution is made.

## Verification coverage and limits

- Read all authored frontend/native source, manifests, configuration, and
  documentation.
- `npm test`: includes frontend contracts plus public-repository and notice-gate
  checks, with no intentionally skipped tests or TODO failures. The
  previously tracked BP-001 TODO is now a normal regression.
  Coverage includes immutable editor state and stale canvas events; export round trips;
  model/MCP contracts; decisions, loops, structured output, cancellation; SDK
  registration/types, incomplete-draft round trips, the native save/recovery bridge,
  and the Copilot authoring contracts above.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`: 22 passing checks
  covering real-filesystem staging, refusal, conflicts, permissions, crash rollback,
  completed commits, draft isolation, process locks, inherited descriptors, and
  restricted Copilot runtime/authentication preparation.
- `npm run build`: strict frontend TypeScript checking and production assets.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and
  `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`:
  native formatting and diagnostics.
- `npm audit`: no reported development or production dependency advisories at
  review time. This is not an exhaustive security assessment.
- Browser checks exercise the approved toolbar/name-card layout, selection and
  deselection, configuration, connections, nested-loop navigation, numeric
  input, model retention, MCP editing, and dialog draft preservation.
- Draft/export UI checks through the Tauri mock bridge confirm the mode defaults,
  strict export validation, saved incomplete numeric fields, model retention on
  reopen, and that saving a draft leaves runnable files unchanged.
- Native close-guard interaction uses the Tauri mock bridge. Filesystem tests
  now run against the native save engine and actual temporary files/processes. Neither substitutes
  for manual native-picker/scoped-permission testing on both operating systems.
- Local Linux native compilation and Debian packaging completed successfully.
  The new Ubuntu/macOS GitHub CI workflows have not been executed from this local
  checkout; a configured workflow is not a passing remote run. macOS compilation,
  native file dialogs, signing, and notarization remain unverified here.
- Authenticated Copilot inference, account-specific model availability, and live
  MCP authentication were not exercised. Generated workflows were run with
  stub agents and checked against the installed SDK; no agent credits were used.
- Production Vite emits a roughly 578 kB JavaScript chunk (about 176 kB gzip).
  Its size warning remains visible. No arbitrary bundle-size workaround or
  extra dependency was added to hide it.

## Structure and complexity

The small, flat project is appropriate for its current size. The editor reducer
now lives in `src/editor-state.ts`, separate from React rendering, with direct
state-transition tests. Domain/schema validation, code generation, filesystem
operations, configuration UI, and native startup already have separate modules.
No new framework, global state store, or web backend was added. Native persistence
uses the Rust standard library plus Serde (already a transitive Tauri dependency).
The Copilot boundary lives in `src/copilot.ts` and `src-tauri/src/copilot.rs`;
`src/Copilot.tsx` contains its account/model/prompt UI. Existing dialog and field
components are shared through `src/ui.tsx`. The official Rust SDK handles process
and authentication protocols instead of a hand-written JSON-RPC or OAuth client.

The complexity-only pass found no substantial architecture to delete. Its
small unused `plus` icon finding has also been removed from `src/Nodes.tsx`.
