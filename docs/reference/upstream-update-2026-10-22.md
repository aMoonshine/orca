# Upstream update: 2026-10-22

Merged `stablyai/orca` main at `de2700d0fbb9d00a45ad3f3e6f79c9d46c65d081`
into `feat/swarm-mode`. The previous fork tip is preserved as
`backup/swarm-before-upstream-2026-10-22` (`e9352b03`).

## Upstream implementations retained

- Agent launch routing, request identity, and terminal/chat surface selection.
- OpenCode execution-host capability checks and model availability validation.
- Worker readiness deadlines and structured-session identity/address handling.
- The new process-host package, dependency lockfile, and build tools.

The portable OpenCode launcher pins 1.18.32, an explicitly verified upstream
model-launch version. Run `tools\orca-dev.cmd install-opencode` after updating an
older checkout. The wrapper installation's outer launcher has the same change.
The launcher builds process-host and refreshes the CLI before starting the app.

## Fork features retained

Master chat, automatic worker panels, the active-team task board, per-agent model
selection, engineering interviews and bundled engineering skills, Run work modes,
decision contracts, and worker file claims remain additions to upstream.
Claims coordinate cooperating agents; they do not sandbox filesystem writes.

## Existing profiles

Upstream and the fork both used schema version 43 for different changes. Version
46 converges both histories: it preserves fork modes/claims/decisions, adds them
to upstream profiles, and applies upstream's session-address migration to old
fork profiles. Regression tests exercise both histories and reopening.

The backup Git branch restores source code, not an already migrated profile.
Do not downgrade a profile by changing its SQLite version number.

## Validation

Validation logs and hidden-window screenshots are kept in the wrapper's ignored
`artifacts` directory. Checks cover the orchestration/RPC suites, both schema
histories, master launch/model overrides, panel placement, type checking, and
the changed-code quality gate against the new upstream tip. The hidden Electron
smoke test opens the master form and retrieves the live OpenCode model list.

Two upstream test harness adjustments are included for this Windows checkout:
close the shared journal database before deleting its temporary directory, and
load the large runtime fixture before timing the CLI keepalive test.
