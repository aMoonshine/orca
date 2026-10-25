# Maintaining this Orca fork

`origin` is `aMoonshine/orca`; `upstream` is `stablyai/orca`. Our changes live on
`feat/swarm-mode`, with upstream `de2700d0fbb9` merged in `b7928b836`. Keep upstream history intact
and keep engineering source imports separate from Orca integration commits.

To update, use a clean, dedicated integration worktree based on the fork:

```sh
git fetch upstream main
git worktree add -b integrate/upstream-YYYY-MM-DD ../orca-update-YYYY-MM-DD feat/swarm-mode
cd ../orca-update-YYYY-MM-DD
node config/scripts/check-swarm-integration.mjs --upstream upstream/main
git merge upstream/main
```

Review the update check before merging. Exit 2 reports overlapping paths that
need review; exit 1 reports a failed check. Follow the
[extension update procedure](../src/packages/swarm/README.md) using the project's
supported Node runtime. Resolve conflicts, regenerate RPC parameter catalogs and bundled skill guides,
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
- [Swarm source extension](../src/packages/swarm/README.md): master and manual
  team UI, lifecycle, profiles, prompts, panel arrangement and pure mode/claim
  policies live in `src/packages/swarm`. The renderer uses one host entry module;
  core mode/claim callers retain stable shared facades. `integration.json` pins
  upstream and records host dependencies. The read-only update check reports
  upstream overlaps before integration. The package is built with our fork.
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
