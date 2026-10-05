# Changelog

Notable user-visible changes are recorded here. There is no published stable
release represented by this file yet.

## Unreleased

### Added

- Local Tauri/React workflow canvas for Ubuntu and macOS.
- Agent configuration, explicit connections, structured decisions, nested
  bounded Repeat loops, and sequential For-each loops.
- Standalone draft saving and validated Copilot extension/agent-profile exports.
- Native scoped saves, overwrite checks, durable journaling, and rollback recovery.
- Optional Copilot login, account model discovery/manual IDs, and reviewed
  system-prompt generation.
- Public contributor, security, privacy, licensing, CI, and release-candidate
  infrastructure.

### Reliability

- Branch joins preserve decision gates and reject ambiguous combinations.
- Modal drafts survive save shortcuts and native close confirmation.
- Generated prompts apply only to the original agent and preserve other settings.
- Save locks are explicitly released even when runtime startup temporarily
  inherits a file descriptor.

### Release status

- Mac signing/notarization, real-account Copilot checks, and the public repository
  settings checklist must be completed before distributing a supported release.
- The bundled Copilot runtime has separate upstream license terms.
