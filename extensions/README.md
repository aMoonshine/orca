# Maintaining this Orca fork

`origin` is `aMoonshine/orca`; `upstream` is `stablyai/orca`. Our changes live on
`feat/swarm-mode`, based on upstream `31012aeb0928`. Keep upstream history intact
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

Pay special attention to schema migrations: the Swarm foundation adds versions
43–45. If upstream later uses those numbers, reconcile both migration chains and
test every starting schema version. Never simply delete a migration or reduce
the stored version. Back up the application profile before testing an update
that changes its database.

## Extension boundaries

- [Engineering](engineering/README.md): licensed, pinned source package plus a
  small prompt adapter. This is a candidate for future plugin extraction.
- Agent group UI: `src/renderer/src/components/agent-group` and
  `src/renderer/src/lib/agent-group-*`. It uses the existing orchestration RPCs.
- Modes, phases, decisions and file claims live in the orchestration runtime and
  database. They currently require core changes; packaging the UI as a plugin
  alone would not remove those dependencies.
- Desktop orchestration request envelopes carry the protocol version and unique
  mutation IDs. Remote hosts need the matching runtime features.

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
