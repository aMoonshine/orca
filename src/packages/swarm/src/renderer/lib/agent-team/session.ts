import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { buildAgentTeamPrompt } from '../../../shared/agent-team-prompt'
import {
  agentTeamConfigurationSchema,
  type AgentTeamConfiguration
} from '../../../shared/agent-team-configuration'
import { teamSessionKey, type AgentTeamHost, type TeamSessionStore } from './contracts'

export type StartAgentTeamArgs = {
  target: RuntimeClientTarget
  worktreeId: string
  configuration: AgentTeamConfiguration
  objective: string
}

export function createTeamSessionCommands(host: AgentTeamHost, sessions: TeamSessionStore) {
  async function start(args: StartAgentTeamArgs): Promise<void> {
    const key = teamSessionKey(args.target, args.worktreeId)
    if (sessions.read(key)) {
      throw new Error(
        'Open the existing master session. Start another team only after detaching it explicitly.'
      )
    }
    const configuration = agentTeamConfigurationSchema.parse(args.configuration)
    const prompt = buildAgentTeamPrompt({ objective: args.objective, configuration })
    const session = host.launchMaster(args.worktreeId, configuration.leader)
    sessions.save(key, session)
    const deadline = Date.now() + 30_000
    let handle = await host.resolveHandle(args.target, args.worktreeId, session)
    while (!handle && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      handle = await host.resolveHandle(args.target, args.worktreeId, session)
    }
    if (!handle) {
      throw new Error(
        'Master terminal startup was not confirmed. Inspect its panel before retrying.'
      )
    }
    await host.bootstrap(args.target, handle, prompt)
  }

  function readSession(target: RuntimeClientTarget, worktreeId: string) {
    return sessions.read(teamSessionKey(target, worktreeId))
  }

  function detachSession(target: RuntimeClientTarget, worktreeId: string) {
    sessions.detach(teamSessionKey(target, worktreeId))
  }

  function openMaster(target: RuntimeClientTarget, worktreeId: string) {
    const session = readSession(target, worktreeId)
    if (!session) {
      throw new Error('No saved master session. Open the workspace to inspect its agents.')
    }
    host.openMaster(worktreeId, session)
  }

  return { start, readSession, detachSession, openMaster, openWorker: host.openWorker }
}
