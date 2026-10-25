import { z } from 'zod'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentTeamConfiguration } from '../../../../shared/agent-team-configuration'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import { newAgentLaunchRequestId } from '../agent-launch-request-id'
import { launchAgentInNewTab } from '../launch-agent-in-new-tab'
import { showAgentGroupPanels } from '../agent-group-panels'
import type { GroupRpc } from '../agent-group-launch'
import { emptyTeamSnapshot, type TeamSession, type TeamSnapshot } from './contracts'

const tasksSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      task_title: z.string().nullable().optional(),
      status: z.string(),
      spec: z.string(),
      result: z.string().nullable()
    })
  )
})
const workersSchema = z.object({
  workers: z.array(
    z.object({
      dispatchId: z.string(),
      taskId: z.string(),
      agentTerminalHandle: z.string().nullable(),
      projection: z.object({ attention: z.object({ requiresAction: z.boolean() }) }).optional()
    })
  ),
  partialHostErrors: z.array(z.object({ environmentId: z.string(), code: z.string() })).optional()
})

export function launchMasterTerminal(
  worktreeId: string,
  leader: AgentTeamConfiguration['leader']
): TeamSession {
  const supportsModel = !!getAgentSessionOptionCatalog(leader.agent)
    ?.supportsWorkerLaunchPreferences
  const result = launchAgentInNewTab({
    agent: leader.agent,
    requestedSurface: 'terminal',
    requestId: newAgentLaunchRequestId(),
    quickCommandLabel: 'Master chat',
    worktreeId,
    sessionOptions: supportsModel
      ? { model: leader.model, ...(leader.effort ? { effort: leader.effort } : {}) }
      : undefined,
    beforeSurfaceOpen: (surface) => surface.kind !== 'host-published'
  })
  if (!result || result.surface.kind === 'host-published') {
    throw new Error(
      'Master launch is unavailable on this connection. No local fallback was started.'
    )
  }
  return { tabId: result.surface.tabId }
}

export async function resolveTeamHandle(
  target: RuntimeClientTarget,
  worktreeId: string,
  session: TeamSession,
  signal?: AbortSignal
): Promise<string | null> {
  signal?.throwIfAborted()
  if (session.handle) {
    return session.handle
  }
  const result = z
    .object({ terminals: z.array(z.object({ handle: z.string(), tabId: z.string() })) })
    .parse(
      await callRuntimeRpc(
        target,
        'terminal.list',
        {
          worktree: `id:${worktreeId}`,
          includeVisualLayouts: false
        },
        { signal }
      )
    )
  signal?.throwIfAborted()
  return result.terminals.find((terminal) => terminal.tabId === session.tabId)?.handle ?? null
}

export async function bootstrapMaster(
  target: RuntimeClientTarget,
  handle: string,
  prompt: string
): Promise<void> {
  const { wait } = z
    .object({ wait: z.object({ satisfied: z.boolean(), status: z.string() }) })
    .parse(
      await callRuntimeRpc(
        target,
        'terminal.wait',
        { terminal: handle, for: 'tui-idle', timeoutMs: 60_000 },
        { timeoutMs: 65_000 }
      )
    )
  if (!wait.satisfied) {
    throw new Error(
      `Master startup is blocked (${wait.status}). Inspect its panel before retrying.`
    )
  }
  const { send } = z
    .object({ send: z.object({ accepted: z.boolean() }) })
    .parse(
      await callRuntimeRpc(
        target,
        'terminal.send',
        { terminal: handle, text: prompt, enter: true, agentPrompt: true, waitSubmitMs: 15_000 },
        { timeoutMs: 30_000 }
      )
    )
  if (!send.accepted) {
    throw new Error('The master did not accept its task. Inspect its panel before retrying.')
  }
}

export async function readTeamSnapshot(
  target: RuntimeClientTarget,
  worktreeId: string,
  session: TeamSession,
  signal: AbortSignal
): Promise<TeamSnapshot> {
  const rpc: GroupRpc = (method, params) => callRuntimeRpc(target, method, params, { signal })
  const from = await resolveTeamHandle(target, worktreeId, session, signal)
  signal.throwIfAborted()
  if (!from) {
    throw new Error('The master terminal is unavailable. Open its session to inspect it.')
  }
  const current = z
    .object({ run: z.object({ id: z.string() }).nullable() })
    .parse(await rpc('orchestration.runCurrent', { from }))
  signal.throwIfAborted()
  if (!current.run) {
    return emptyTeamSnapshot
  }
  const id = current.run.id
  const [modeRaw, tasksRaw, workersRaw] = await Promise.all([
    rpc('orchestration.runMode', { from, id }),
    rpc('orchestration.taskList', { run: id }),
    rpc('orchestration.workerList', { run: id, includeRemote: true })
  ])
  signal.throwIfAborted()
  const { workMode } = z
    .object({
      workMode: z.object({
        mode: z.enum(['solo', 'swarm', 'fusion', 'orchestrator']),
        phaseId: z.string()
      })
    })
    .parse(modeRaw)
  const tasks = tasksSchema.parse(tasksRaw).tasks
  const { workers, partialHostErrors } = workersSchema.parse(workersRaw)
  const error = partialHostErrors?.map((host) => `${host.environmentId}: ${host.code}`).join('\n')
  return { run: { id, from, ...workMode }, tasks, workers, error: error || null }
}

export async function arrangeTeamPanels(
  target: RuntimeClientTarget,
  snapshot: TeamSnapshot,
  membership: Set<string>,
  signal: AbortSignal,
  isCurrent: () => boolean
): Promise<void> {
  if (!snapshot.run) {
    return
  }
  const handles = [
    ...new Set([
      snapshot.run.from,
      ...snapshot.workers
        .map((worker) => worker.agentTerminalHandle)
        .filter((handle): handle is string => !!handle)
    ])
  ]
  const rpc: GroupRpc = (method, params) => callRuntimeRpc(target, method, params, { signal })
  await showAgentGroupPanels(
    rpc,
    handles.map((handle) => ({
      state: 'ready',
      effects: [{ kind: 'terminal', role: 'agent', id: handle }]
    })),
    true,
    membership,
    isCurrent
  )
}

export function openMasterSession(worktreeId: string, session: TeamSession): void {
  const state = useAppStore.getState()
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
    (entry) => entry.id === session.tabId || entry.entityId === session.tabId
  )
  if (!tab) {
    throw new Error(
      'The master panel is unavailable. Inspect the workspace before starting another team.'
    )
  }
  state.activateTab(tab.id, { worktreeId })
}

export async function openTeamWorker(target: RuntimeClientTarget, handle: string): Promise<void> {
  await callRuntimeRpc(target, 'terminal.focus', { terminal: handle, navigation: 'caller' })
}
