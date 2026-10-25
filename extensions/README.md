# Maintaining this Orca fork

`origin` is `aMoonshine/orca`; `upstream` is `stablyai/orca`. Our changes live on
`feat/swarm-mode`, with upstream `de2700d0fbb9` merged in `b7928b836`. Keep upstream history intact
and keep engineering source imports separate from Orca integration commits.

To update, start from a clean working tree and make an integration branch:

```sh
git fetch upstream main
git switch feat/swarm-mode
git switch -c integrate/upstream-YYYY-MM-DD
git merge upstream/main
```

Resolve conflicts, regenerate RPC parameter catalogs and bundled skill guides,
run node/web/CLI typechecks, orchestration and touched-feature tests, and the
changed-code quality gate. Review the result before merging it back into
`feat/swarm-mode` and pushing to `origin`. Do not force-push the fork's shared
branch or overwrite upstream's main branch with our feature branch.

Schema version 46 reconciles the fork's versions 43–45 with upstream's version
43 through `migrate-v46.ts`: it applies the fork tables and upstream session
address migration to both lineages. For later updates, check both migration
chains and test every supported starting version. Never delete a migration or
reduce the stored version. Back up the application profile before testing an
update that changes its database.

## Extension boundaries

- [Engineering](engineering/README.md): licensed, pinned source package plus a
  small prompt adapter. This is a candidate for future plugin extraction.
- Agent group UI: `src/renderer/src/components/agent-group` and
  `src/renderer/src/lib/agent-group-*`. It uses the existing orchestration RPCs.
- Master sessions: `src/renderer/src/lib/agent-team/`. `session.ts` validates and
  starts a session, `session-state.ts` owns saved identity, and `monitor.ts` owns
  shared polling and subscription lifetime. The UI imports `agentTeams` from
  `agent-team/index.ts`; `use-agent-team.ts` is the React subscription bridge.
  `createAgentTeamClient(host, sessions)` composes the session and monitor modules
  using the explicit `AgentTeamHost` and `TeamSessionStore` interfaces.
  `runtime.ts` contains Orca-specific RPC, launch, store and panel operations.
  Saved keys and launch receipts are unchanged. Unknown submission outcomes keep
  the master attached to prevent duplicate launches. This is an internal module
  boundary, not a separately installable plugin or a new orchestration protocol.
  See [master team modules](../docs/readme/agent-team-modules.md) for ownership,
  integration rules and the remaining requirements for plugin distribution.
- Modes, phases and file claims live in the orchestration runtime and
  database. They currently require core changes; packaging the UI as a plugin
  alone would not remove those dependencies.
- Desktop orchestration request envelopes carry the protocol version and unique
  mutation IDs. Remote hosts need the matching runtime features.

Coordinators pass agreed interfaces and work orders through task instructions or
project documents; there is no standing-decision runtime API. Historical decision
tables and their shipped migrations remain to preserve existing profile data.
Upstream decision gates remain available independently. Modes and claims operate
on the workspace's owning runtime; federated `worker-start --on` currently
accepts only Solo without file claims.

See [agent groups](../docs/reference/agent-groups.md) for behavior and limitations.

## Windows source development

The tracked entry point is `tools\orca-dev.cmd`. In a fresh checkout, install
project dependencies according to the root README, then use `install-node`,
`install`, `doctor`, and `dev`. It pins portable Node 24.21.0 under ignored
`tools/runtime`; nothing is added to the global PATH or registry. Node 26's LTO
configuration breaks this project's MSVC native-module build.

The existing outer `orca_swarm\tools\orca-dev.cmd` continues to work for the
current wrapper layout. The tracked launcher locates the repository directly,
so a GitHub clone no longer depends on that wrapper. Agent CLIs, Git, compiler
prerequisites and a shell remain external dependencies. `install` rebuilds native
modules; it does not install missing JavaScript dependencies.
