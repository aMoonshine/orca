import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentTeamConfiguration } from '../../../../shared/agent-team-configuration'
import type { GroupRun, GroupTask } from '../agent-group-launch'

export type TeamSession = { tabId: string; handle?: string }
export type TeamSnapshot = {
  run: GroupRun | null
  tasks: GroupTask[]
  workers: {
    dispatchId: string
    taskId: string
    agentTerminalHandle: string | null
    projection?: { attention: { requiresAction: boolean } }
  }[]
  error: string | null
}
export const emptyTeamSnapshot: TeamSnapshot = { run: null, tasks: [], workers: [], error: null }

export function teamSessionKey(target: RuntimeClientTarget, worktreeId: string): string {
  return `orca.team-session.${JSON.stringify(target)}.${worktreeId}`
}

export type TeamSessionStore = {
  read: (key: string) => TeamSession | null
  save: (key: string, session: TeamSession) => void
  detach: (key: string) => void
}

export type AgentTeamHost = {
  launchMaster: (worktreeId: string, leader: AgentTeamConfiguration['leader']) => TeamSession
  resolveHandle: (
    target: RuntimeClientTarget,
    worktreeId: string,
    session: TeamSession
  ) => Promise<string | null>
  bootstrap: (target: RuntimeClientTarget, handle: string, prompt: string) => Promise<void>
  readSnapshot: (
    target: RuntimeClientTarget,
    worktreeId: string,
    session: TeamSession,
    signal: AbortSignal
  ) => Promise<TeamSnapshot>
  arrangePanels: (
    target: RuntimeClientTarget,
    snapshot: TeamSnapshot,
    membership: Set<string>,
    signal: AbortSignal,
    isCurrent: () => boolean
  ) => Promise<void>
  openMaster: (worktreeId: string, session: TeamSession) => void
  openWorker: (target: RuntimeClientTarget, handle: string) => Promise<void>
}
