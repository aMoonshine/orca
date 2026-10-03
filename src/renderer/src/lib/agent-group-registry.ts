import { z } from 'zod'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { AgentGroupController, type GroupRun } from './agent-group-launch'
import { showAgentGroupPanels } from './agent-group-panels'
const controllers = new Map<string, AgentGroupController>()
const savedRunSchema = z.object({
  id: z.string(),
  from: z.string(),
  mode: z.enum(['solo', 'swarm', 'fusion', 'orchestrator']),
  phaseId: z.string()
})

export function getAgentGroupController(
  target: RuntimeClientTarget,
  worktreeId: string
): AgentGroupController {
  const key = `orca.agent-group.${JSON.stringify(target)}.${worktreeId}`
  const existing = controllers.get(key)
  if (existing) {
    return existing
  }
  let run: GroupRun | null = null
  try {
    run = savedRunSchema.parse(JSON.parse(localStorage.getItem(key) ?? 'null'))
  } catch {
    /* No saved Run. */
  }
  const controller = new AgentGroupController(
    (method, params) => callRuntimeRpc(target, method, params, { timeoutMs: 180_000 }),
    (value) => {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* Runtime remains authoritative. */
      }
    },
    run,
    (receipts) =>
      showAgentGroupPanels(
        (method, params) => callRuntimeRpc(target, method, params),
        receipts
      ).then(() => {})
  )
  controllers.set(key, controller)
  return controller
}
