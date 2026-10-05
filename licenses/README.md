# Notice provenance

These are upstream license notices, not additional licenses for Blueprint.
Retain them verbatim. Revisit all of them when upgrading the corresponding SDK,
runtime, or frontend packages.

| File | Upstream source |
| --- | --- |
| `copilot-cli-1.0.90.txt` | GitHub's `github/copilot-cli` release `v1.0.90`, `package/LICENSE.md` from `github-copilot-1.0.90.tgz`; also in the tagged repository as `LICENSE.md` |
| `copilot-sdk-MIT.txt` | `github-copilot-sdk` crate 1.0.16, packaged `LICENSE` |
| `copilot-runtime-adm-zip-MIT.txt` | Copilot runtime 1.0.90 Linux x64 package, `package/foundry-local-sdk/node_modules/foundry-local-sdk/node_modules/adm-zip/LICENSE` |
| `copilot-runtime-webview-MIT.txt` | Copilot runtime 1.0.90 Linux x64 package, `package/webview/node_modules/@webviewjs/webview/LICENSE` |
| `tauri-MIT.txt` | The installed `@tauri-apps/api` package's `LICENSE-MIT` |

The two Tauri frontend plugins include SPDX attribution declarations but not full
license text. The notice generator retains those declarations and includes the
same Tauri project's MIT text, selecting MIT from the plugins' dual-license grant.

The Copilot license was also compared against the exact SDK-pinned Linux runtime
archive (SHA-256
`46a672976160b56c0e6e1451c1f7f0ff568cd0e2a12e4e0926f735c9c75e054b`).
The two additional notices supplied with that archive are retained conservatively,
including optional components not selected by the SDK's reduced runtime bundle.
Review platform-specific upstream artifacts and any changed helper binaries when
upgrading; these files do not independently audit the closed runtime's dependencies.

`generated/` is recreated from installed, locked dependencies and is intentionally
not committed. It **must** be included in every binary distribution. Generation
fails rather than quietly dropping an unrecognized/missing package license.

Native notices cover Ubuntu x86_64, macOS arm64, and macOS x86_64 dependencies.
They can include dependencies not linked on every individual target.
Maintainers must review redistribution obligations and required source
availability; automatic notice generation is not a legal review.
