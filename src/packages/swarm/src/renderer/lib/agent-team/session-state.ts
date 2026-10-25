import { z } from 'zod'
import type { TeamSession } from './contracts'

const savedSchema = z.object({ tabId: z.string(), handle: z.string().optional() })
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
