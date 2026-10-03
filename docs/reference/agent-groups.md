# Launching agent groups

## Master chat

**Launch agents** now opens **Master chat** by default. Enter one goal, select the
master CLI/model and worker CLI/model, then choose up to 20 workers and **Start team**.
The master is a real CLI conversation in the selected workspace. It checks the
target, creates orchestration Tasks, dispatches workers with the exact model,
handles questions and reviews results. Task decomposition and supervision are
agent-driven; the count is an instruction to the master, not an OS resource quota.
You can change the requested team and give follow-up instructions in that panel.

The launcher waits for host-side CLI readiness before sending the bootstrap. It
saves the master identity before delivery and refuses duplicate starts after an
unknown outcome. **Open master chat** returns to that session. **Detach saved team**
removes only the shortcut; it does not stop or reassign existing agents.

Workers appear automatically beside the master in separate resizable panels.
Each new panel splits the largest existing team panel. The existing split-tree,
dragging and terminal sessions are reused. The master retains settled workers so
you can give them new instructions directly. Switching projects keeps their work
running; automatic arrangement follows the currently visible workspace.

The existing workspace kanban has an **Active team tasks** view. It projects the
current master's real Task rows into To do, In progress, Reported and Needs attention.
Reported means a worker report exists; read the master's verification before
accepting the result. The board and group messages refresh every five seconds
while mounted. Host-reported requests for guidance, input and other attention move
active tasks into Needs attention; questions remain in Group messages and the
master's inbox until handled. The UI does not infer failure from a missing host.

Local and SSH terminal launches reuse Orca's existing launch routing. A paired
browser/host-published master launch is currently refused before opening a surface;
it never falls back to the local machine. Real Windows validation used OpenCode
1.18.34 and `opencode/space-bunny-free`; other providers still need their own login.

React Grab's development picker is now opt-in: set `VITE_ENABLE_REACT_GRAB=true`
before starting the development app to restore it.

## Manual launch

Open a workspace and choose **Launch agents → Manual launch** (the people icon next to the tab-bar
plus button). Choose Solo, Swarm, Fusion, or Orchestrator, enter a group goal, and
give each agent a task. The picker uses enabled agents detected on that workspace's
host. A wave can contain up to six agents; Solo, Planning, Judge, and Integration
use one agent.

Choose **Model** for each agent before launching. **Apply to all** copies the model
to workers using the same CLI. Changing a worker's CLI clears its model selection;
the form saves explicit choices for the next launch. The selected model overrides
model flags in the CLI's default arguments before the task is sent.

**Refresh models** queries the workspace's execution host. OpenCode uses
`opencode models` and passes the selected `provider/model` ID with `--model`
(verified with the project-pinned CLI 1.18.34). Other agents use their existing
Orca model discovery adapters. If discovery fails, enter an exact model ID;
providers without launch-time model support use their CLI configuration.
The catalog does not verify provider login, quota, or a local server's availability.

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

Worker terminals appear in split panels automatically. Additional workers split
the largest existing group panel. Existing terminal sessions
are moved, not restarted. Resize the dividers or drag panels to change the layout.
The launch dialog closes after a successful wave. Reopen **Launch agents** to read
tasks, group messages, and advance the phase. Failed starts keep the dialog open,
show their failed stage and error, and refresh task state from the execution host.

## Windows agent installation

Agents run as terminal CLIs inside Orca. The OpenCode desktop executable is not a
CLI, although Windows can resolve both through the name `opencode`. Group launch
rejects the known desktop path immediately instead of waiting for agent readiness.

The source launcher supports `tools\orca-dev.cmd install-opencode`. This installs
OpenCode CLI 1.18.34 under `tools/runtime/opencode-cli` and prepends its binary folder
only for Orca's process tree. It does not change the global Windows PATH. Restart
Orca through the launcher after installation. `doctor` reports the resolved path.
The runtime folder is ignored by Git; the installer and pinned version are tracked.
Package provenance: [OpenCode CLI installation](https://dev.opencode.ai/docs).

Codex, Claude, and other agents still use their installed CLIs or a command set in
Settings. Installation and authentication are separate: the provider must have a
working login/API configuration. A local model also requires its server to be
running. `Cannot connect to API` inside OpenCode means that its configured model
endpoint is unavailable, even if Orca successfully started the terminal.

Newer desktop orchestration requests include a contract version and a unique
mutation identity. An older remote runtime that lacks work-mode RPCs is rejected
before any worker is launched. Remote execution stays on the workspace's owning
runtime; a missing or ambiguous owner is an error.
