# Project governance

Blueprint is currently a maintainer-led community project. The repository owner,
[@LazaroHurtado](https://github.com/LazaroHurtado), is the initial maintainer and
release approver. There is no steering committee, paid support commitment, or
implied affiliation with GitHub.

## Decisions

Discuss substantial scope, dependency, workflow-format, and UX changes in an issue
before a large implementation. The maintainer makes the final merge/release
decision based on usefulness, compatibility, reliability, and maintenance cost.
Explain important tradeoffs in the issue or PR so future contributors can follow
the reasoning. Revisit a decision with new evidence rather than personal pressure.

Contributors retain credit for their work. Regular, constructive contributors
may be invited to maintain areas of the project; permissions and responsibilities
should be explicit before access is granted.

## Releases and compatibility

Blueprint uses semantic version numbers, but the `0.x` series and upstream
dynamic-workflow APIs are experimental. Document breaking changes and migration
requirements before releasing them. Changes to saved documents, agent filenames,
the application identifier, or recovery data need particular care.

Release candidates and public releases are different. Only a maintainer may
approve publication after the [release gates](docs/RELEASING.md#release-gates).
CI does not automatically publish tags, releases, or signed artifacts.

Community behavior is governed by the [code of conduct](CODE_OF_CONDUCT.md).
