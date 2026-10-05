# Contributing to Blueprint

Thank you for helping make visual workflow authoring more useful and reliable.
Follow the [code of conduct](CODE_OF_CONDUCT.md) in project spaces.

## Choose a change

Check existing [issues](https://github.com/LazaroHurtado/blueprint/issues) first.
For a substantial feature or behavior change, describe the user problem and
proposed scope before implementing it. Small fixes and documentation corrections
can go directly to a pull request. Do not create speculative frameworks, plugin
systems, or configuration for hypothetical requirements.

For vulnerabilities, use [private reporting](SECURITY.md), not a public issue.
Never attach real credentials, recovery journals, or confidential workflows.

## Set up and validate

Follow [DEVELOPING.md](docs/DEVELOPING.md), create a branch, then run:

```sh
npm ci
npm run check
npm test
npm run build
npm run check:native
```

Use the smallest relevant check while iterating; run the commands above before a
PR is ready for review. Native checks require the documented system dependencies.
The tests use stubs or isolated SDK sessions and must not authenticate a real
account, launch a login browser, or consume Copilot inference allowance.

## Implementation expectations

- Preserve offline authoring and the approved minimal canvas layout.
- Keep TypeScript strict, use two-space indentation, and format Rust with rustfmt.
- Prefer native platform controls and existing helpers over new dependencies.
- Do not store credentials in the renderer, workflow documents, examples, or logs.
- Keep import validation, executable-export validation, and draft serialization
  consistent. Do not weaken validation to make a fixture pass.
- Treat unsaved-change guards, modal drafts, and recovery behavior as data-loss
  boundaries. Add a regression check when changing them.
- Change only the requested scope. Include a focused test and relevant docs for
  nontrivial behavior changes. State what could not be verified.

New dependencies need a concrete reason, compatible licensing, and lockfile
updates. For SDK upgrades, review runtime compatibility and regenerate notices;
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Do not commit generated
installers, dependency directories, license-generation output, or signing files.

## Submit a pull request

Explain the problem, solution, behavior changes, and validation. For UI work,
include screenshots using synthetic data. Describe accessibility and small-window
behavior where relevant. Keep PRs reviewable rather than mixing unrelated cleanup
with a feature.

Maintainers may request changes or defer a feature to protect the project's scope.
CI passing is necessary, not sufficient, for merging. Review decisions follow
[GOVERNANCE.md](GOVERNANCE.md).

By submitting a contribution, you confirm you have the right to contribute it and
agree it can be distributed under Blueprint's MIT license. Third-party material
must keep its original notices. No contributor license agreement or sign-off bot
is currently required. If using AI assistance, review the result yourself and
disclose material limitations; do not submit code or data you are not entitled to share.
