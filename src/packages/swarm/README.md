# Orca Swarm extension

This is our built-in source extension, versioned separately in `package.json`
and compiled with our Orca fork. It does not require upstream maintainers to
adopt a plugin API. It cannot be installed into an unmodified Orca binary.

## What belongs here

- `src/renderer/components`: master and manual launch forms, model/profile
  selection, presets, team board and group messages.
- `src/renderer/lib`: team lifecycle, shared monitoring, launch-wave controller,
  model discovery and automatic panel arrangement.
- `src/shared`: master configuration and prompt, engineering prompt adapter,
  work-mode definitions and file-claim path rules.

`src/renderer/lib/agent-team/client.ts` accepts an `AgentTeamHost` and a
`TeamSessionStore`. Its Orca adapters remain in `runtime.ts` and `session-state.ts`.
The UI and the shared policies are source modules with host dependencies, not
an independent runtime. Dependencies are declared in `integration.json`.

## Small host entry surface

The app shell, tab bar and kanban use `src/renderer/src/extensions/swarm.ts`.
The orchestration runtime and CLI keep importing the existing
`src/shared/swarm/{mode-protocols,file-claim-path-key}.ts` facades. These facades
export the package's implementation, so existing runtime callers do not need
to know the package's internal layout.

The host owns UI primitives, routing, terminals, the application store and model
capabilities. The package reuses them. Tailwind explicitly scans the package's
renderer directory, and the existing test runner discovers its tests under `src`.
Typecheck configurations include renderer and shared code in their appropriate
targets. The root dependency install supplies the package's libraries.
Localization catalog scanning, coverage auditing and design-system checks include
the extracted renderer too. The coverage audit retains six findings already
present before extraction: four translated lane fallback labels, a technical
file-path placeholder and the untranslated coordinator terminal title. They are
not silently allowlisted by this move.

## Core changes that remain necessary

Our fork still extends the orchestration database and worker lifecycle for run
modes, phase admission, file claims, release and caller fencing. Their migrations,
RPC contracts and CLI handlers remain in core. Moving this code into a directory
cannot make those changes optional or replace the existing orchestration bus.

The compatibility baseline is upstream `de2700d0fbb9d00a45ad3f3e6f79c9d46c65d081`.
That upstream revision already provides the Run/Task/Dispatch bus, supervised
workers, questions, decision gates and resizable split panes. This package adds
our work-mode policies, master/profile workflow and team-aware panel arrangement.
This statement describes the pinned source revision, not an unchecked latest release.

## Updating our extension

Develop package changes in an isolated worktree of this fork. Keep the existing
host interface for routine UI, prompt, preset and mode-policy changes. A new host
dependency must be reviewed and added to `integration.json`; the check does not
automatically expand that list. Increment the package version for a released
extension change. Keep changes to core adapters in separate commits where practical.

From the checkout root, using its supported Node runtime:

```sh
node config/scripts/check-swarm-integration.mjs
node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/packages/swarm
node node_modules/typescript/bin/tsc --noEmit -p config/tsconfig.tc.web.json
node node_modules/typescript/bin/tsc --noEmit -p config/tsconfig.node.json
node node_modules/typescript/bin/tsc --noEmit -p config/tsconfig.tc.cli.json
```

Run agent-launched checks with `ORCA_BACKGROUND_LAUNCH=1`. On this Windows host,
prepend the project-managed Node 24 runtime as described in the root `AGENTS.md`.
Then run the changed-code gate against the task's starting commit and format only
changed files. The package uses the existing pnpm workspace and adds no dependencies.

## Updating Orca underneath the extension

1. Start from a clean fork revision in a dedicated integration worktree. Keep the
   normal development checkout and active application profile separate.
2. Fetch `upstream/main`, then run:

   ```sh
   node config/scripts/check-swarm-integration.mjs --upstream upstream/main
   ```

3. Review reported upstream edits to host dependencies, overlaps with **all**
   preserved fork changes, and collisions with extension-owned paths. Exit 2 means
   review is required. Exit 1 means the integration check itself failed. A zero
   exit means no recorded path overlap; it does not prove semantic compatibility.
4. Merge the selected upstream revision in that integration worktree. Preserve
   the extension and reconcile actual core changes rather than copying an old
   whole application directory over upstream.
5. Run the integration check, package tests, all typechecks and the changed-code
   gate. Regenerate RPC catalogs and bundled guides if their source changed.
   Changes to orchestration require its lifecycle, RPC and migration suites,
   including both upstream and fork database lineages. UI/build changes require
   a renderer build and an appropriate application smoke check.
6. Only after validation, update `upstreamBase` in `integration.json` to the
   reviewed upstream commit. Commit that change with the integration result and
   merge it into the fork through the usual review process.

The checker is read-only: it does not fetch, merge, modify refs, launch agents or
touch application profiles. `--json` emits the same report for automation. Missing
history or an unrelated upstream revision fails closed. Fetch the pinned baseline
if a shallow clone does not contain it.

Core database and protocol changes must stay compatible with retained application
profiles and remote hosts. Do not reset migration numbers or remove historical
tables to make a merge pass. Our schema-v46 reconciliation is described in
`extensions/README.md`.

Independent development is available now at the source-package level. A ZIP
installer or hot-loadable plugin is not part of this package; updates still
produce a build of our fork.
