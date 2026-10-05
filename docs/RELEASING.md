# Preparing a release

Blueprint is currently an early-access release candidate, not a certified
cross-platform release. This document is the maintainer's publication checklist.
Do not turn incomplete checks into a "stable" or "supported" claim.

## Release gates

Before public binary publication, record evidence for every applicable gate:

- [ ] Create/configure `LazaroHurtado/blueprint`, confirm source ownership and MIT
  licensing, and review all files included in the first commit.
- [ ] Enable GitHub private vulnerability reporting and confirm its reporting
  link works; review the security/conduct support routes.
- [ ] Protect `main`: require PRs, the CI checks, and maintainer review. Require
  approval for workflows from outside contributors; do not expose signing or
  Copilot credentials to pull-request jobs.
- [ ] Complete the Ubuntu x86_64, macOS arm64, and macOS Intel CI jobs.
- [ ] Test install/uninstall, cold startup, native pickers and scoped access,
  overwrite approval, recovery, keyboard interaction, and minimum window size
  on the actual supported OS/architecture.
- [ ] Complete browser OAuth, cancel/retry, unavailable/locked keychain,
  existing-account reuse, model-policy failure, and a consented real prompt
  generation on each platform. Automated tests do not cover these claims.
- [ ] Review exact runtime redistribution terms, generated notices, MPL source
  links/availability, and any newly bundled system libraries. Do not strip
  notices or distribute the Copilot runtime as a standalone product.
- [ ] Sign and notarize macOS release bundles with a maintainer-owned identity;
  verify nested bundled executables and runtime extraction behavior on a clean
  machine. Candidate workflow artifacts are unsigned and not notarized.
- [ ] Review dependency advisories and perform the appropriate security review.
  A passing test suite is not a vulnerability assessment.
- [ ] Verify versions, release notes, checksums, licenses/resources inside the
  final artifacts, and the artifact-to-source commit relationship.

Repository settings, credentials, real-platform checks, and legal approval are
maintainer actions. They are not performed by generating these files.

## Version and changelog

Keep the version equal in `package.json`, `package-lock.json`,
`src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
`npm run check` verifies this. `npm version --no-git-tag-version` can update the
npm pair; edit the Cargo/Tauri versions in the same PR.

Move the relevant `CHANGELOG.md` entries into a dated version section when a
release is actually approved. Prefer a prerelease for the initial community
rollout. Do not label development snapshots as already published.

## Generate notices and build locally

```sh
npm ci
cargo install cargo-about --version 0.9.2 --locked --features cli
npm run check
npm test
npm run check:native
npm run notices
```

The notice tool can fetch missing upstream license text. Review errors instead of
lowering its threshold or bypassing a license that has not been assessed.
Regenerate notices after changing a lockfile, runtime version, license policy,
or notice generator. The build checks input/output hashes and refuses stale files.

On Ubuntu:

```sh
npm run package -- --bundles deb -- --locked
```

On a Mac of the architecture being built:

```sh
npm run package -- --bundles app -- --locked
```

These commands build local artifacts; they do not upload them. Outputs live under
`src-tauri/target/release/bundle/`. The regular `tauri build` hook also verifies
notices, so bypassing the npm packaging alias does not bypass the check.
The final `-- --locked` forwards Cargo's lockfile flag through Tauri.

To collect a local candidate, run `node scripts/collect-artifacts.mjs` after the
native build. Start without an existing `release-artifacts/` directory; preserve
or relocate a previous candidate rather than mixing builds. Local builds without
a commit are explicitly marked uncommitted/not approved for publication. CI
rejects unknown revisions or a modified source tree.
Check `SHA256SUMS.txt` with `sha256sum --check` on Ubuntu or
`shasum -a 256 --check` on macOS from inside the collected directory.
This collector labels candidates as not Developer ID signed or notarized; it is
not the final signed-release publication process.

## Candidate workflow

The manually dispatched **Release candidate** workflow validates the selected
source revision, generates notices, and builds an Ubuntu `.deb` plus separate
macOS Apple Silicon/Intel `.app` bundles. macOS apps are transported as `.tar.gz`
archives to preserve executable permissions and symlinks.

Each Actions artifact contains its package, source/build metadata, license files,
and SHA-256 checksums. This is a **candidate build**, not a GitHub Release:
the workflow has read-only repository permissions and cannot publish a release,
push a tag, or sign an app. It uses no Copilot or signing credentials.

Building an unsigned macOS candidate is useful for validation, but do not instruct
community users to disable Gatekeeper as an installation procedure. Follow
[Tauri's macOS signing guidance](https://v2.tauri.app/distribute/sign/macos/)
in a protected maintainer-controlled release environment, then verify signing
and notarization before creating distributable archives and checksums.

## Inspect and publish

Inspect Debian dependencies and resources with `dpkg-deb --info` and
`dpkg-deb --contents`. The package must include Blueprint's license, the Copilot
license, and generated frontend/native notices. It must declare `xdg-utils`
for browser opening; GTK/WebKit and other native library dependencies must remain.

Inspect macOS `Contents/Resources`, executable modes, architectures, code
signatures, and notarization. Verify generated notice manifests against the exact
source/locks used to build each artifact. Regenerate checksums after signing or
any other artifact modification.

Only after the gates are complete should a maintainer create the version tag and
GitHub prerelease/release, attach the reviewed artifacts/checksums/notices, and
document install instructions and remaining limitations. Keep provenance tied to
the reviewed commit. Do not claim signing, reproducibility, or provenance
attestations that were not actually produced and verified.
