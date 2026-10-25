import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { buildAgentTeamPrompt } from '../../../../shared/agent-team-prompt'
import {
  agentTeamConfigurationSchema,
  type AgentTeamConfiguration
} from '../../../../shared/agent-team-configuration'
import { readTeamSession, saveTeamSession, teamSessionKey } from './session-state'
import { bootstrapMaster, launchMasterTerminal, resolveTeamHandle } from './runtime'

export async function startAgentTeam(args: {
  target: RuntimeClientTarget
  worktreeId: string
  configuration: AgentTeamConfiguration
  objective: string
}): Promise<void> {
  const key = teamSessionKey(args.target, args.worktreeId)
  if (readTeamSession(key)) {
    throw new Error(
      'Open the existing master session. Start another team only after detaching it explicitly.'
    )
  }
  const configuration = agentTeamConfigurationSchema.parse(args.configuration)
  const prompt = buildAgentTeamPrompt({ objective: args.objective, configuration })
  const session = launchMasterTerminal(args.worktreeId, configuration.leader)
  saveTeamSession(key, session)
  const deadline = Date.now() + 30_000
  let handle = await resolveTeamHandle(args.target, args.worktreeId, session)
  while (!handle && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    handle = await resolveTeamHandle(args.target, args.worktreeId, session)
  }
  if (!handle) {
    throw new Error('Master terminal startup was not confirmed. Inspect its panel before retrying.')
  }
  await bootstrapMaster(args.target, handle, prompt)
}
