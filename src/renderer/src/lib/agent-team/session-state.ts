import { z } from 'zod'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const savedSchema = z.object({ tabId: z.string(), handle: z.string().optional() })
export type TeamSession = z.infer<typeof savedSchema>
export function teamSessionKey(target: RuntimeClientTarget, worktreeId: string): string {
  return `orca.team-session.${JSON.stringify(target)}.${worktreeId}`
}
export function readTeamSession(key: string): TeamSession | null {
  try {
    return savedSchema.parse(JSON.parse(localStorage.getItem(key) ?? 'null'))
  } catch {
    return null
  }
}

export function saveTeamSession(key: string, session: TeamSession): void {
  localStorage.setItem(key, JSON.stringify(session))
}

export function detachTeamSession(key: string): void {
  localStorage.removeItem(key)
}
