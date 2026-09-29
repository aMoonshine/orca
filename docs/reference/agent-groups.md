# Launching agent groups

Open a workspace and choose **Launch agents** (the people icon next to the tab-bar
plus button). Choose Solo, Swarm, Fusion, or Orchestrator, enter a group goal, and
give each agent a task. The picker uses enabled agents detected on that workspace's
host. A wave can contain up to six agents; Solo, Planning, Judge, and Integration
use one agent.

For a planning interview, enter the goal and choose **Discuss before implementation**.
This opens one agent with `grill-with-docs`, asks one question at a time, and saves
agreed decisions in project documents. Other engineering workflows are available
in the same selector; see [engineering workflows](../../extensions/engineering/README.md).

The mode belongs to the Run. The desktop saves the form and the last Run reference
per workspace and runtime in local storage. Reopening the dialog restores them;
Refresh reads the authoritative Run and tasks from its host. These preferences do
not change other Runs or make a workspace permanently use one mode.

## Phases and ownership

- Swarm: Coordination → Implementation → Catch-up, in the same workspace.
- Fusion: Panel → Judge → Integration. Transfer the reviewed work order into the
  integrator's task. Panel isolation is an instruction, not filesystem isolation.
- Orchestrator: Planning → Implementation → Integration. Implementation creates
  a separate child Git worktree for each worker; a plain folder workspace cannot
  create those worktrees. Include branches and integration instructions in the
  integrator's task.
- Solo: Work.

The user coordinates the phases in this UI. Read task results, then use **Advance
to…** and write the next wave's tasks. Refresh also lets the user see updated
results. **Group messages** shows the Run's messages and supports answers to worker
questions. This UI does not automatically judge reports or advance phases.

Writable group phases require each worker's **Owned paths**, separated by commas.
The existing orchestration claim store rejects conflicting paths before opening
a worker terminal. Read-only phases omit claims and instruct agents not to edit;
the filesystem itself is not sandboxed by this feature.

## Partial starts and recovery

The launch button creates one coordinator terminal and one Run, then starts the
requested wave in order. Each Task is stored before its worker starts. A refusal
or unknown outcome stops the remaining queue and preserves the Run, task, and
available dispatch receipt. Completed starts are not rolled back. Refresh and
inspect the task or dispatch before taking another action; there is no automatic
retry. Another wave and phase advancement require all existing tasks to be settled.

The coordinator terminal anchors the Run's identity. Keep it open while using the
group. If its binding is gone, the UI reports the problem instead of taking over
another Run. **New group** starts a fresh form context; it does not stop previous
agents. Existing terminal/CLI recovery and release commands remain available.

Newer desktop orchestration requests include a contract version and a unique
mutation identity. An older remote runtime that lacks work-mode RPCs is rejected
before any worker is launched. Remote execution stays on the workspace's owning
runtime; a missing or ambiguous owner is an error.
