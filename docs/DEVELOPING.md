# Development

Blueprint uses React, strict TypeScript, Vite, React Flow, Zod, and Tauri 2.
Rust owns filesystem transactions and Copilot processes. There is no web backend,
database, or frontend Copilot SDK runtime.

## Prerequisites

- Node.js **24.x** with npm. CI uses Node 24; newer versions are not the current
  compatibility baseline.
- Rustup. `rust-toolchain.toml` selects **Rust 1.94.0**, rustfmt, and Clippy.
- Git and the platform dependencies below.
- Network access for initial npm/Cargo resolution and the SDK's pinned runtime
  download. Building from source is not entirely offline on a cold machine.

### Ubuntu 24.04

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential pkg-config libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf xdg-utils ca-certificates
```

Copilot login also needs a default browser and a usable, unlocked Secret Service
keychain in the desktop session. Installing a library is not the same as running
a keychain service. Do not work around missing storage by putting tokens in code.

### macOS 15+

Install Xcode Command Line Tools with `xcode-select --install`, then install Node
and rustup using their official instructions. Use a native Apple Silicon or Intel
toolchain for the architecture being tested. macOS build/runtime/signing status
is tracked in [RELEASING.md](RELEASING.md), not inferred from Ubuntu results.

The [Tauri prerequisite guide](https://v2.tauri.app/start/prerequisites/) is the
upstream reference if platform packages change.

## Run locally

```sh
npm ci
npm run tauri dev
```

The browser preview is `npm run dev` at `http://localhost:1420`; the port is strict.
The preview can edit/import graphs but cannot save through native dialogs or use
Copilot. Stop an old preview before starting another.

Do not run development as root. Copilot is optional and its account should not
be needed for ordinary development or automated tests.

## Checks

```sh
npm run check
npm test
npm run build
npm run check:native
```

`check` type-checks the frontend and verifies repository metadata, documentation
links, example workflows, and source hygiene. `test` uses Node's built-in runner,
including experimental module mocks; its Node experimental warnings are expected.
`check:native` runs rustfmt, Clippy with warnings denied, and Rust tests with
`Cargo.lock` unchanged.

Native checks include process-level save recovery and an isolated bundled-runtime
smoke test. The smoke test checks restricted tools and prepares/cancels OAuth
without opening a browser or submitting an inference request. Do not substitute
real credentials or authorize a real login in CI.

For a focused frontend change:

```sh
node --experimental-test-module-mocks --test src/copilot.test.ts
```

For export tests, also include Node's `--experimental-vm-modules` flag.
For a focused native change, pass a test-name filter to
`cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`.

## Project map

| Surface | Location |
| --- | --- |
| Document types, import/draft validation, graph semantics | `src/workflow.ts` |
| Generated TypeScript, extension JavaScript, agent Markdown | `src/export.ts` |
| Immutable canvas state | `src/editor-state.ts` |
| Editor, configuration, and shared forms | `src/App.tsx`, `src/Inspector.tsx`, `src/ui.tsx` |
| Copilot UI and typed IPC | `src/Copilot.tsx`, `src/copilot.ts` |
| Native file bridge | `src/files.ts` |
| Native command registration and lifecycle | `src-tauri/src/lib.rs` |
| Recoverable file transactions | `src-tauri/src/persistence.rs` |
| Pinned Copilot runtime and restricted sessions | `src-tauri/src/copilot.rs` |

## Dependencies and packaging

Keep both `package-lock.json` and `src-tauri/Cargo.lock` committed.
The Node SDK checks exported workflow contracts; the Rust SDK ships the authoring
runtime. An SDK/runtime upgrade needs protocol, privacy, and notice review.
Do not update all dependencies as incidental cleanup.

`private: true` in `package.json` and `publish = false` in Cargo intentionally
prevent accidental npm/crates.io publication. They do not make GitHub source private.

Build distributable candidates using [RELEASING.md](RELEASING.md). Generated
dependency notices are not required for frontend-only work, but release packaging
refuses to continue without current notices.
