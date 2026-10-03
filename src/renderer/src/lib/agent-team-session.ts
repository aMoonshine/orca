import { z } from 'zod'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { launchAgentInNewTab } from './launch-agent-in-new-tab'
import { buildAgentTeamPrompt } from '../../../shared/agent-team-prompt'
import type { TuiAgent } from '../../../shared/tui-agent'

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
export async function startAgentTeam(args: {
  target: RuntimeClientTarget
  worktreeId: string
  leader: TuiAgent
  leaderModel: string
  agent: TuiAgent
  model: string
  count: number
  objective: string
}): Promise<void> {
  const key = teamSessionKey(args.target, args.worktreeId)
  if (readTeamSession(key)) {
    throw new Error(
      'Open the existing master session. Start another team only after detaching it explicitly.'
    )
  }
  const prompt = buildAgentTeamPrompt(args)
  if (!args.leaderModel.trim()) {
    throw new Error('Choose an exact model for the master agent.')
  }
  const result = launchAgentInNewTab({
    agent: args.leader,
    terminalOnly: true,
    quickCommandLabel: 'Master chat',
    worktreeId: args.worktreeId,
    sessionOptions: { model: args.leaderModel },
    beforeSurfaceOpen: (surface) => surface.kind !== 'host-published'
  })
  if (!result || result.surface.kind === 'host-published') {
    throw new Error(
      'Master launch is unavailable on this connection. No local fallback was started.'
    )
  }
  const session: TeamSession = {
    tabId: result.surface.tabId,
    ...(result.surface.kind === 'local-agent-session'
      ? { handle: `session:${result.surface.sessionId}` }
      : {})
  }
  localStorage.setItem(key, JSON.stringify(session))
  const deadline = Date.now() + 30_000
  let handle = await resolveTeamHandle(args.target, args.worktreeId, session)
  while (!handle && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    handle = await resolveTeamHandle(args.target, args.worktreeId, session)
  }
  if (!handle) {
    throw new Error('Master terminal startup was not confirmed. Inspect its panel before retrying.')
  }
  const { wait } = z
    .object({ wait: z.object({ satisfied: z.boolean(), status: z.string() }) })
    .parse(
      await callRuntimeRpc(
        args.target,
        'terminal.wait',
        { terminal: handle, for: 'tui-idle', timeoutMs: 60_000 },
        { timeoutMs: 65_000 }
      )
    )
  if (!wait.satisfied) {
    throw new Error(
      `Master startup is blocked (${wait.status}). Inspect its panel before retrying.`
    )
  }
  const { send } = z
    .object({ send: z.object({ accepted: z.boolean() }) })
    .parse(
      await callRuntimeRpc(
        args.target,
        'terminal.send',
        { terminal: handle, text: prompt, enter: true, agentPrompt: true, waitSubmitMs: 15_000 },
        { timeoutMs: 30_000 }
      )
    )
  if (!send.accepted) {
    throw new Error('The master did not accept its task. Inspect its panel before retrying.')
  }
}

export async function resolveTeamHandle(
  target: RuntimeClientTarget,
  worktreeId: string,
  session: TeamSession
): Promise<string | null> {
  if (session.handle) {
    return session.handle
  }
  const result = z
    .object({ terminals: z.array(z.object({ handle: z.string(), tabId: z.string() })) })
    .parse(
      await callRuntimeRpc(target, 'terminal.list', {
        worktree: `id:${worktreeId}`,
        includeVisualLayouts: false
      })
    )
  return result.terminals.find((terminal) => terminal.tabId === session.tabId)?.handle ?? null
}
