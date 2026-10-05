# Contributor and coding-agent instructions

Read `README.md`, `CONTRIBUTING.md`, and `docs/DEVELOPING.md` before changes.
This is an independent, early-access desktop authoring tool, not a workflow runner.

## Structure and commands

- `src/workflow.ts`: document schema, validation, graph planning, and drafts.
- `src/export.ts`: deterministic workflow and agent-profile generation.
- `src/editor-state.ts`: immutable editor updates and saved snapshots.
- `src/App.tsx`, `Inspector.tsx`, `Copilot.tsx`, `ui.tsx`: UI and modal lifecycles.
- `src/files.ts`, `src/copilot.ts`: narrow, typed native command bridges.
- `src-tauri/src/persistence.rs`, `copilot.rs`: native save/recovery and Copilot.
- `scripts/`: public-repository checks and distribution notices.

Use `npm run check`, `npm test`, `npm run build`, and `npm run check:native`.
Run the smallest relevant checks while iterating. Packaging requires
`npm run notices`; see `docs/RELEASING.md`. Use locked dependency resolution.

## Required invariants

- Keep offline/manual authoring usable when Copilot is absent or unavailable.
- Do not execute imported code. Do not run workflows or paid model requests as tests.
- Keep credentials and MCP configuration out of prompt-generation IPC payloads.
- Preserve unknown model IDs; do not silently substitute an available model.
- Apply a generated prompt only after user approval, only to its original agent,
  and without replacing unrelated agent settings.
- Preserve open modal drafts across save shortcuts, close confirmation, and login.
- Keep draft serialization distinct from executable validation.
- Never bypass picker-granted scopes, overwrite conflicts, save locks, or recovery.
- Do not change the application identifier or document format without migration work.
- Preserve the exact license notices and regenerate them on dependency changes.

Keep changes focused. Prefer native controls, the standard library, and existing
helpers; do not add state frameworks or a custom OAuth/JSON-RPC client.
Use strict TypeScript, two-space frontend indentation, and rustfmt for Rust.
Surface failures instead of success-shaped fallbacks. Update relevant docs and
add a focused regression for nontrivial behavior changes.

Do not commit credentials, real workflow data, journals, generated build outputs,
or signing material. Do not publish, tag, push, or change repository settings
unless explicitly asked. Report unverified platforms or external integrations
honestly instead of claiming a public release is ready.
