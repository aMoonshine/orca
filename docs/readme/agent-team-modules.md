# Master team modules

The master team is an internal module with an explicit host interface. It is not
an installable Orca plugin. Its implementation lives in
`src/packages/swarm/src/renderer/lib/agent-team/`.

## Ownership

| File               | Responsibility                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `contracts.ts`     | Session identity, snapshots, scope key and host/storage interfaces                              |
| `client.ts`        | Compose session commands and shared monitoring for one client instance                          |
| `session.ts`       | Validate configuration, start once, preserve uncertain outcomes, open and detach saved sessions |
| `monitor.ts`       | One poll per target/workspace, subscribers, cancellation and panel membership                   |
| `runtime.ts`       | Adapt Orca terminal launch, owner-routed RPC, tab store and existing panel arrangement          |
| `session-state.ts` | Validate and persist session identity in browser local storage                                  |
| `index.ts`         | Construct the desktop client with Orca adapters; public UI entry point                          |

The session and monitor modules receive `AgentTeamHost` and `TeamSessionStore`.
They do not import the Orca runtime adapter, browser storage, application store or
React. `createAgentTeamClient` can be exercised with a different host and session
store without initializing the desktop. Instances own separate polling and panel
membership maps. The desktop deliberately uses one shared instance.

The lifecycle module belongs to the [Swarm source package](../../src/packages/swarm/README.md).
Configuration, prompts and group types are owned by that package; runtime-target
types and host operations remain Orca dependencies. It is compiled with our fork.

## UI integration

UI callers import `agentTeams` from the package's `lib/agent-team` entry point. Its interface provides:

- `start({ target, worktreeId, configuration, objective })`;
- `readSession(target, worktreeId)` and `detachSession(target, worktreeId)`;
- `openMaster(target, worktreeId)` and `openWorker(target, handle)`;
- `subscribe(target, worktreeId, listener, arrange?)` and
  `getSnapshot(target, worktreeId)`.

React callers use `useAgentTeam` for subscription lifetime. `AgentTeamControl`
uses the commands, `AgentTeamBoard` reads snapshots and opens workers, and
`ActiveAgentTeam` subscribes with panel arrangement enabled. Adding another view
must reuse this client rather than add a polling loop or import `runtime.ts`.
`teamSessionKey` also supplies the form's stable identity across target/workspace
changes; saved local-storage keys retain their existing format.

## Host and lifetime rules

The host adapter owns execution routing and capability checks. RPC operations
stay on the requested runtime, with no local fallback. Launches preserve exact
model/effort choices and the existing CLI readiness/submission checks.

Session storage operations are synchronous. Starting saves the identity before
awaiting discovery or prompt delivery. A blocked launch, rejected submission or
unknown outcome retains it and prevents another start. Detaching removes only
the saved shortcut; it does not stop terminals, settle tasks or release workers.
The next poll clears the detached team's snapshot.

Subscribers in one scope share a five-second poll, and polls do not overlap.
Unsubscribing the last listener aborts the active request and removes its timer.
An abandoned response or a changed session cannot publish or arrange panels.
Panel membership survives temporary unmounting so returning to the same team
does not discard a manual resize. The host checks cancellation and `isCurrent`
before applying asynchronous panel changes and updates the supplied membership
set using the existing panel implementation.

Snapshots retain usable task data alongside partial-host diagnostics. A missing
host does not imply that its agents exited. This module neither retries workers
nor judges completion nor advances orchestration phases.

## Distribution without upstream API changes

The supported path is the built-in Swarm source package plus our maintained core
changes. Its package README documents extension development and upstream updates.
The following plugin limitations explain why an unmodified Orca binary is not a
supported installation target.

## Independent plugin distribution

Orca's current plugin host exposes workspace context, explicit-terminal text,
panels, commands, events and plugin storage. It does not expose the launch,
readiness, orchestration and split-panel operations required by this adapter.

Distribution as an installable plugin therefore needs a supported, versioned
host contribution with caller authorization, capability discovery and execution
ownership for those operations. A plugin adapter could then implement the same
interfaces. The current interfaces are internal TypeScript contracts, not a wire
protocol or a public plugin API.

Run modes, phases, file claims and their database migrations remain in Orca's
orchestration runtime. The existing SQLite bus remains authoritative. Engineering
workflow sources stay in `extensions/engineering`; they are a separate extraction
candidate. There is no additional message bus or database in the master module.

## Validation

`agent-team/client.test.ts` exercises the host interface without the desktop or
browser storage, including instance isolation and cancellation. Existing
`agent-team-session.test.ts`, `use-agent-team.test.ts` and
`AgentTeamControl.test.tsx` cover real adapter composition, launch failures,
duplicate prevention, shared polling, panel layout, target isolation and form
configuration. These tests do not prove live provider login or remote execution.
