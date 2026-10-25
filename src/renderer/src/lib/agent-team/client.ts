import type { AgentTeamHost, TeamSessionStore } from './contracts'
import { createTeamMonitor } from './monitor'
import { createTeamSessionCommands } from './session'

export function createAgentTeamClient(host: AgentTeamHost, sessions: TeamSessionStore) {
  return { ...createTeamSessionCommands(host, sessions), ...createTeamMonitor(host, sessions) }
}
