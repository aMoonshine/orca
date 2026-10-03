import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ launch: vi.fn(), rpc: vi.fn() }))
vi.mock('./launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launch }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
import { startAgentTeam, readTeamSession, teamSessionKey } from './agent-team-session'

const args = {
  target: { kind: 'local' as const },
  worktreeId: 'folder:test',
  leader: 'opencode' as const,
  leaderModel: 'provider/master',
  agent: 'opencode' as const,
  model: 'provider/worker',
  count: 2,
  objective: 'Review only'
}
describe('master session lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const saved = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value)
    })
    mocks.launch.mockReturnValue({ surface: { kind: 'local-terminal', tabId: 'master-tab' } })
    mocks.rpc.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'terminal.list') {
        return { terminals: [{ handle: 'term-master', tabId: 'master-tab' }] }
      }
      if (method === 'terminal.wait') {
        return { wait: { satisfied: true, status: 'satisfied' } }
      }
      if (method === 'terminal.send') {
        return { send: { accepted: true } }
      }
      throw new Error(method)
    })
  })
  it('waits for the real CLI before sending the bootstrap exactly once and prevents duplicate starts', async () => {
    await startAgentTeam(args)
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({ terminalOnly: true, sessionOptions: { model: 'provider/master' } })
    )
    expect(mocks.launch.mock.calls[0][0].prompt).toBeUndefined()
    expect(mocks.rpc.mock.calls.map(([, method]) => method)).toEqual([
      'terminal.list',
      'terminal.wait',
      'terminal.send'
    ])
    expect(mocks.rpc.mock.calls[2][2]).toMatchObject({
      terminal: 'term-master',
      agentPrompt: true,
      text: expect.stringContaining('provider/worker')
    })
    await expect(startAgentTeam(args)).rejects.toThrow('existing master')
    expect(mocks.launch).toHaveBeenCalledTimes(1)
  })
  it('keeps the master identity and never sends a task if startup is blocked', async () => {
    mocks.rpc.mockImplementation(async (_target: unknown, method: string) =>
      method === 'terminal.list'
        ? { terminals: [{ handle: 'term-master', tabId: 'master-tab' }] }
        : { wait: { satisfied: false, status: 'timeout' } }
    )
    await expect(startAgentTeam(args)).rejects.toThrow('blocked')
    expect(mocks.rpc.mock.calls.some(([, method]) => method === 'terminal.send')).toBe(false)
    expect(readTeamSession(teamSessionKey(args.target, args.worktreeId))).toEqual({
      tabId: 'master-tab'
    })
  })
})
