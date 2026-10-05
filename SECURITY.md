# Security policy

## Report privately

Use GitHub's **[Report a vulnerability](https://github.com/LazaroHurtado/blueprint/security/advisories/new)**
for suspected security issues. Do not publish exploit details, credentials, private
workflows, or logs in ordinary issues.

Private vulnerability reporting must be enabled by the repository owner before
public release. If the button is unavailable, open a minimal issue titled
"Private security contact requested" with **no technical details or attachments**.
Wait for a private channel before sharing the report.

Include affected versions, OS/architecture, a synthetic reproduction, impact,
and any proposed mitigation. Use accounts, files, and services you control.
Do not test against other users, production services, or repositories without
permission. This volunteer project cannot promise an acknowledgment or fix SLA,
and does not currently offer a bug bounty.

## Supported versions and scope

There is no stable public support branch yet. During early access, security fixes
target `main` and the latest published prerelease. Older development snapshots
should not be assumed to receive backports.

Relevant boundaries include imported documents, generated code, tool/MCP
configuration, native file scopes and recovery, OAuth/browser handling, and
the renderer/native IPC boundary. Upstream Copilot service, SDK, or runtime
vulnerabilities should also be reported through GitHub's applicable private
security channel; coordinate disclosure rather than posting them publicly here.

## Safe operation

- Treat imported workflows and generated agent instructions as untrusted input.
- Review exported code and tool permissions before running it.
- Do not grant a workflow blanket command/file access merely to get past an error.
- Keep credentials out of prompts and workflow files; use environment references.
- Do not delete a pending recovery journal to silence a save error.
- Unsigned candidate artifacts are not a production security or provenance claim.

See [privacy](docs/PRIVACY.md), [known boundaries](docs/ISSUES.md), and
[release gates](docs/RELEASING.md#release-gates). Existing automated checks and
dependency scans are not a comprehensive security assessment.
