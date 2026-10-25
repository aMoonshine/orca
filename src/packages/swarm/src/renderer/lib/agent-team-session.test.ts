import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ launch: vi.fn(), rpc: vi.fn() }))
vi.mock('../../../../../renderer/src/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launch
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
import { agentTeams, teamSessionKey } from './agent-team/index'
import { readTeamSession } from './agent-team/session-state'

const startAgentTeam = agentTeams.start

const args = {
  target: { kind: 'local' as const },
  worktreeId: 'folder:test',
  configuration: {
    leader: { agent: 'codex' as const, model: 'gpt-6.1-sol', effort: 'high' },
    profiles: [
      {
        id: 'free',
        agent: 'opencode' as const,
        model: 'opencode/big-pickle',
        purpose: 'Routine work'
      },
      {
        id: 'complex',
        agent: 'codex' as const,
        model: 'gpt-6.1-sol',
        effort: 'high',
        purpose: 'Complex implementation'
      }
    ],
    parallelismHint: 32
  },
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
      expect.objectContaining({
        requestedSurface: 'terminal',
        sessionOptions: { model: 'gpt-6.1-sol', effort: 'high' }
      })
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
      text: expect.stringContaining('opencode/big-pickle')
    })
    expect(mocks.rpc.mock.calls[2][2].text).toContain('"effort":"high"')
    expect(mocks.rpc.mock.calls[2][2].text).toContain('Initial parallelismHint: 32')
    expect(mocks.rpc.mock.calls.every(([target]) => target === args.target)).toBe(true)
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
  it('launches unsupported providers with CLI defaults and bootstraps workers without model overrides', async () => {
    await startAgentTeam({
      ...args,
      configuration: {
        leader: { agent: 'gemini', model: '' },
        profiles: [{ id: 'default', agent: 'gemini', model: '', purpose: 'General work' }],
        parallelismHint: 1
      }
    })
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'gemini', sessionOptions: undefined })
    )
    expect(mocks.rpc.mock.calls[2][2].text).toContain('Omit --model')
    expect(mocks.rpc.mock.calls[2][2].text).toContain('"agent":"gemini"')
  })
  it.each([
    { agent: 'gemini' as const, model: 'explicit/model' },
    { agent: 'opencode' as const, model: '' }
  ])('rejects an invalid master override before opening a surface: %s', async (leader) => {
    await expect(
      startAgentTeam({ ...args, configuration: { ...args.configuration, leader } })
    ).rejects.toThrow()
    expect(mocks.launch).not.toHaveBeenCalled()
  })
  it('rejects invalid worker preferences before launching the master', async () => {
    await expect(
      startAgentTeam({
        ...args,
        configuration: {
          ...args.configuration,
          profiles: [
            {
              id: 'unsupported',
              agent: 'opencode',
              model: 'opencode/big-pickle',
              effort: 'high',
              purpose: ''
            }
          ]
        }
      })
    ).rejects.toThrow()
    expect(mocks.launch).not.toHaveBeenCalled()
  })
  it('keeps the saved master after a send failure and refuses an unknown retry', async () => {
    mocks.rpc.mockImplementation(async (_target: unknown, method: string) => {
      if (method === 'terminal.list') {
        return { terminals: [{ handle: 'term-master', tabId: 'master-tab' }] }
      }
      if (method === 'terminal.wait') {
        return { wait: { satisfied: true, status: 'satisfied' } }
      }
      throw new Error('connection lost')
    })
    await expect(startAgentTeam(args)).rejects.toThrow('connection lost')
    await expect(startAgentTeam(args)).rejects.toThrow('existing master')
    expect(mocks.launch).toHaveBeenCalledTimes(1)
  })
  it('keeps a rejected submission attached and prevents a duplicate launch', async () => {
    const original = mocks.rpc.getMockImplementation()!
    mocks.rpc.mockImplementation(async (target, method, params, options) =>
      method === 'terminal.send'
        ? { send: { accepted: false } }
        : original(target, method, params, options)
    )
    await expect(startAgentTeam(args)).rejects.toThrow('did not accept')
    await expect(startAgentTeam(args)).rejects.toThrow('existing master')
    expect(mocks.launch).toHaveBeenCalledTimes(1)
    expect(mocks.rpc.mock.calls.filter(([, method]) => method === 'terminal.send')).toHaveLength(1)
  })
})
