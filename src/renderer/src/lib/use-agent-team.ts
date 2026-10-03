import { useEffect, useState } from 'react'
import { z } from 'zod'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { readTeamSession, resolveTeamHandle, teamSessionKey } from './agent-team-session'
import { showAgentGroupPanels } from './agent-group-panels'
import type { GroupRun, GroupTask } from './agent-group-launch'

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
  )
})
export function useAgentTeam(target: RuntimeClientTarget, worktreeId: string, arrange = false) {
  const [run, setRun] = useState<GroupRun | null>(null)
  const [tasks, setTasks] = useState<GroupTask[]>([])
  const [workers, setWorkers] = useState<z.infer<typeof workersSchema>['workers']>([])
  const [error, setError] = useState<string | null>(null)
  const key = teamSessionKey(target, worktreeId)
  useEffect(() => {
    let cancelled = false
    let refreshing = false
    let signature = ''
    async function refresh() {
      if (cancelled || refreshing) {
        return
      }
      refreshing = true
      try {
        const session = readTeamSession(key)
        if (!session) {
          setRun(null)
          setTasks([])
          setWorkers([])
          return
        }
        const from = await resolveTeamHandle(target, worktreeId, session)
        if (!from) {
          throw new Error('The master terminal is unavailable. Open its session to inspect it.')
        }
        const current = z
          .object({ run: z.object({ id: z.string() }).nullable() })
          .parse(await callRuntimeRpc(target, 'orchestration.runCurrent', { from }))
        if (!current.run) {
          if (!cancelled) {
            setRun(null)
            setTasks([])
            setWorkers([])
            setError(null)
          }
          return
        }
        const id = current.run.id
        const [modeRaw, tasksRaw, workersRaw] = await Promise.all([
          callRuntimeRpc(target, 'orchestration.runMode', { from, id }),
          callRuntimeRpc(target, 'orchestration.taskList', { run: id }),
          callRuntimeRpc(target, 'orchestration.workerList', { run: id })
        ])
        const { workMode } = z
          .object({
            workMode: z.object({
              mode: z.enum(['solo', 'swarm', 'fusion', 'orchestrator']),
              phaseId: z.string()
            })
          })
          .parse(modeRaw)
        const nextTasks = tasksSchema.parse(tasksRaw).tasks
        const nextWorkers = workersSchema.parse(workersRaw).workers
        if (cancelled) {
          return
        }
        setRun({ id, from, ...workMode })
        setTasks(nextTasks)
        setWorkers(nextWorkers)
        setError(null)
        const handles = [
          ...new Set([
            from,
            ...nextWorkers
              .map((worker) => worker.agentTerminalHandle)
              .filter((handle): handle is string => !!handle)
          ])
        ]
        const nextSignature = JSON.stringify(handles)
        if (arrange && nextSignature !== signature) {
          const visible = await showAgentGroupPanels(
            (method, params) => callRuntimeRpc(target, method, params),
            handles.map((handle) => ({
              state: 'ready',
              effects: [{ kind: 'terminal', role: 'agent', id: handle }]
            })),
            true
          )
          if (visible === handles.filter((handle) => !handle.startsWith('session:')).length) {
            signature = nextSignature
          }
        }
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      } finally {
        refreshing = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [key, target, worktreeId, arrange])
  return { run, tasks, workers, error }
}
