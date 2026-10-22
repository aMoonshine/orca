import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { z } from 'zod'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { readTeamSession, resolveTeamHandle, teamSessionKey } from './agent-team-session'
import { showAgentGroupPanels } from './agent-group-panels'
import type { GroupRpc, GroupRun, GroupTask } from './agent-group-launch'

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
const panelMembershipByTeam = new Map<string, { runId: string; tabs: Set<string> }>()

type TeamSnapshot = {
  run: GroupRun | null
  tasks: GroupTask[]
  workers: z.infer<typeof workersSchema>['workers']
  error: string | null
}
type TeamMonitor = {
  snapshot: TeamSnapshot
  subscribers: Map<() => void, boolean>
  controller: AbortController
  refreshing: boolean
  timer?: ReturnType<typeof setInterval>
}
const emptySnapshot: TeamSnapshot = { run: null, tasks: [], workers: [], error: null }
const monitors = new Map<string, TeamMonitor>()

function publish(monitor: TeamMonitor, snapshot: TeamSnapshot) {
  monitor.snapshot = snapshot
  for (const listener of monitor.subscribers.keys()) {
    listener()
  }
}

async function refreshTeam(
  monitor: TeamMonitor,
  key: string,
  target: RuntimeClientTarget,
  worktreeId: string
) {
  const session = readTeamSession(key)
  const isCurrent = () => {
    const saved = readTeamSession(key)
    return (
      !monitor.controller.signal.aborted &&
      saved?.tabId === session?.tabId &&
      saved?.handle === session?.handle
    )
  }
  if (!isCurrent() || monitor.refreshing) {
    return
  }
  monitor.refreshing = true
  const rpc: GroupRpc = (method, params) =>
    callRuntimeRpc(target, method, params, { signal: monitor.controller.signal })
  try {
    if (!session) {
      panelMembershipByTeam.delete(key)
      publish(monitor, emptySnapshot)
      return
    }
    const from = await resolveTeamHandle(target, worktreeId, session)
    if (!isCurrent()) {
      return
    }
    if (!from) {
      throw new Error('The master terminal is unavailable. Open its session to inspect it.')
    }
    const current = z
      .object({ run: z.object({ id: z.string() }).nullable() })
      .parse(await rpc('orchestration.runCurrent', { from }))
    if (!isCurrent()) {
      return
    }
    if (!current.run) {
      panelMembershipByTeam.delete(key)
      publish(monitor, emptySnapshot)
      return
    }
    const id = current.run.id
    const [modeRaw, tasksRaw, workersRaw] = await Promise.all([
      rpc('orchestration.runMode', { from, id }),
      rpc('orchestration.taskList', { run: id }),
      rpc('orchestration.workerList', { run: id, includeRemote: true })
    ])
    if (!isCurrent()) {
      return
    }
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
    publish(monitor, { run: { id, from, ...workMode }, tasks, workers, error: error || null })
    if ([...monitor.subscribers.values()].some(Boolean)) {
      let membership = panelMembershipByTeam.get(key)
      if (membership?.runId !== id) {
        membership = { runId: id, tabs: new Set<string>() }
        panelMembershipByTeam.set(key, membership)
      }
      const handles = [
        ...new Set([
          from,
          ...workers
            .map((worker) => worker.agentTerminalHandle)
            .filter((handle): handle is string => !!handle)
        ])
      ]
      await showAgentGroupPanels(
        rpc,
        handles.map((handle) => ({
          state: 'ready',
          effects: [{ kind: 'terminal', role: 'agent', id: handle }]
        })),
        true,
        membership.tabs,
        () => isCurrent() && [...monitor.subscribers.values()].some(Boolean)
      )
    }
  } catch (reason) {
    if (isCurrent()) {
      publish(monitor, {
        ...monitor.snapshot,
        error: reason instanceof Error ? reason.message : String(reason)
      })
    }
  } finally {
    monitor.refreshing = false
  }
}

export function useAgentTeam(target: RuntimeClientTarget, worktreeId: string, arrange = false) {
  const environmentId = target.kind === 'environment' ? target.environmentId : undefined
  const runtimeTarget = useMemo<RuntimeClientTarget>(
    () =>
      environmentId === undefined ? { kind: 'local' } : { kind: 'environment', environmentId },
    [environmentId]
  )
  const key = teamSessionKey(runtimeTarget, worktreeId)
  const subscribe = useCallback(
    (listener: () => void) => {
      let monitor = monitors.get(key)
      if (!monitor) {
        monitor = {
          snapshot: emptySnapshot,
          subscribers: new Map(),
          controller: new AbortController(),
          refreshing: false
        }
        monitors.set(key, monitor)
      }
      const shared = monitor
      shared.subscribers.set(listener, arrange)
      if (shared.subscribers.size === 1) {
        void refreshTeam(shared, key, runtimeTarget, worktreeId)
        shared.timer = setInterval(
          () => void refreshTeam(shared, key, runtimeTarget, worktreeId),
          5000
        )
      }
      return () => {
        shared.subscribers.delete(listener)
        if (shared.subscribers.size === 0) {
          clearInterval(shared.timer)
          shared.controller.abort()
          monitors.delete(key)
        }
      }
    },
    [key, runtimeTarget, worktreeId, arrange]
  )
  const getSnapshot = useCallback(() => monitors.get(key)?.snapshot ?? emptySnapshot, [key])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
