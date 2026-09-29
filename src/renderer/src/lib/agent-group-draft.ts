import { z } from 'zod'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import type { GroupWorker } from './agent-group-launch'
import type { AgentWorkMode } from '../../../shared/swarm/mode-protocols'

const draftSchema = z.object({
  mode: z.enum(['solo', 'swarm', 'fusion', 'orchestrator']),
  objective: z.string(),
  workers: z
    .array(
      z.object({
        id: z.string(),
        agent: z.string().refine(isTuiAgent),
        spec: z.string(),
        claims: z.string()
      })
    )
    .min(1)
    .max(6)
})
export type AgentGroupDraft = { mode: AgentWorkMode; objective: string; workers: GroupWorker[] }

export function loadGroupDraft(key: string): AgentGroupDraft | null {
  try {
    const parsed = draftSchema.parse(JSON.parse(localStorage.getItem(key) ?? 'null'))
    const workers: GroupWorker[] = []
    for (const worker of parsed.workers) {
      if (isTuiAgent(worker.agent)) {
        workers.push({ ...worker, agent: worker.agent })
      }
    }
    return { ...parsed, workers }
  } catch {
    return null
  }
}

export function saveGroupDraft(key: string, draft: AgentGroupDraft): void {
  try {
    localStorage.setItem(key, JSON.stringify(draft))
  } catch {
    /* Storage may be unavailable. */
  }
}
