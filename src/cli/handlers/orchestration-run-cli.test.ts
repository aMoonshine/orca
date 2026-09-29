import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { printResult } from '../format'
import { ORCHESTRATION_HANDLERS } from './orchestration'
import type { RuntimeClient } from '../runtime-client'

/**
 * The handler context the CLI dispatcher builds, with a call spy standing in for the
 * RuntimeClient. Centralised so each test states only its flags; every assertion in this
 * file is about the RPC name and params forwarded, not about the transport.
 */
function runHandler(
  command: string,
  flags: Map<string, string | boolean>,
  json = true
): Promise<void> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake exposes only `call`, which is the single RuntimeClient method these handlers use; the rest of the client is transport the handlers never touch.
  const client = { call: callMock } as unknown as RuntimeClient
  return ORCHESTRATION_HANDLERS[command]({ flags, client, cwd: '/tmp/repo', json })
}

describe('lightweight Run CLI handlers', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
  })

  it('creates a Run with the resolved coordinator terminal', async () => {
    callMock.mockResolvedValue({
      result: { run: { id: 'run_1', objective: 'Coordinate work', consumer_generation: 1 } }
    })
    await ORCHESTRATION_HANDLERS['orchestration run-create']({
      flags: new Map<string, string | boolean>([
        ['objective', 'Coordinate work'],
        ['json', true]
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
    expect(callMock).toHaveBeenCalledWith('orchestration.runCreate', {
      objective: 'Coordinate work',
      from: 'term_coord'
    })
  })

  it('sends the chosen mode with run-create, and omits it when unset', async () => {
    callMock.mockResolvedValue({
      result: { run: { id: 'run_1', objective: 'Work', consumer_generation: 1 } }
    })
    await runHandler(
      'orchestration run-create',
      new Map<string, string | boolean>([
        ['objective', 'Work'],
        ['mode', 'swarm'],
        ['json', true]
      ])
    )
    expect(callMock).toHaveBeenLastCalledWith('orchestration.runCreate', {
      objective: 'Work',
      from: 'term_coord',
      mode: 'swarm'
    })
  })

  it('rejects an unknown mode at the CLI instead of sending it to the host', async () => {
    await expect(
      runHandler(
        'orchestration run-create',
        new Map<string, string | boolean>([
          ['objective', 'Work'],
          ['mode', 'mothership']
        ])
      )
    ).rejects.toThrow(/mothership/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('advances the phase through the runPhaseAdvance method', async () => {
    callMock.mockResolvedValue({
      result: {
        workMode: { mode: 'swarm', phaseId: 'implementation', round: 1, isFinalPhase: false },
        phases: [{ phase: 'coordination', phase_round: 1 }]
      }
    })
    await runHandler(
      'orchestration run-phase-advance',
      new Map<string, string | boolean>([
        ['from', 'term_coord'],
        ['json', true]
      ])
    )
    expect(callMock).toHaveBeenCalledWith('orchestration.runPhaseAdvance', {
      from: 'term_coord',
      id: undefined
    })
  })

  it('requires a mode on run-mode-set', async () => {
    await expect(
      runHandler(
        'orchestration run-mode-set',
        new Map<string, string | boolean>([['from', 'term_coord']])
      )
    ).rejects.toThrow(/--mode/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('reads the mode without mutating it', async () => {
    callMock.mockResolvedValue({
      result: {
        workMode: { mode: 'swarm', phaseId: 'coordination', round: 1, isFinalPhase: false },
        phases: [{ phase: 'coordination', phase_round: 1 }]
      }
    })
    await runHandler(
      'orchestration run-mode',
      new Map<string, string | boolean>([['from', 'term_coord']])
    )
    expect(callMock).toHaveBeenCalledWith('orchestration.runMode', {
      from: 'term_coord',
      id: undefined
    })
  })

  it('reuses the same explicit binding path for run-use and run-current', async () => {
    callMock
      .mockResolvedValueOnce({ result: { run: { id: 'run_1', objective: 'Work' } } })
      .mockResolvedValueOnce({ result: { run: { id: 'run_1', objective: 'Work' } } })
    await ORCHESTRATION_HANDLERS['orchestration run-use']({
      flags: new Map([
        ['id', 'run_1'],
        ['from', 'term_coord']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
    await ORCHESTRATION_HANDLERS['orchestration run-current']({
      flags: new Map([['from', 'term_coord']]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
    expect(callMock).toHaveBeenNthCalledWith(1, 'orchestration.runUse', {
      id: 'run_1',
      from: 'term_coord'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.runCurrent', {
      from: 'term_coord'
    })
  })

  it('passes Run pagination flags to the runtime', async () => {
    callMock.mockResolvedValue({
      result: { runs: [], nextCursor: null }
    })

    await ORCHESTRATION_HANDLERS['orchestration run-list']({
      flags: new Map([
        ['limit', '25'],
        ['cursor', 'next-page']
      ]),
      client: { call: callMock },
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith('orchestration.runList', {
      limit: 25,
      cursor: 'next-page'
    })
  })

  it('opts into bounded Run pagination by default', async () => {
    callMock.mockResolvedValue({ result: { runs: [], nextCursor: null } })

    await ORCHESTRATION_HANDLERS['orchestration run-list']({
      flags: new Map(),
      client: { call: callMock },
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith('orchestration.runList', {
      limit: 100,
      cursor: undefined
    })
  })

  it('passes explicit legacy takeover only when requested', async () => {
    callMock.mockResolvedValue({
      result: { run: { id: 'run_adopted', objective: 'Recovered work' } }
    })
    await ORCHESTRATION_HANDLERS['orchestration run-use']({
      flags: new Map<string, string | boolean>([
        ['id', 'run_adopted'],
        ['from', 'term_current'],
        ['takeover-legacy', true]
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith('orchestration.runUse', {
      id: 'run_adopted',
      from: 'term_current',
      takeoverLegacy: true
    })
  })
})

describe('orchestration reset CLI handler', () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ result: { reset: 'all' } })
  })
  const invoke = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration reset']({
      flags,
      client: { call: callMock },
      json: true
    } as never)

  it('rejects a bare reset before calling the runtime', async () => {
    await expect(invoke(new Map())).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Choose exactly one reset scope: --all, --tasks, or --messages.'
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('sends only the tasks scope for --tasks', async () => {
    await invoke(new Map([['tasks', true]]))
    expect(callMock).toHaveBeenCalledWith('orchestration.reset', {
      all: undefined,
      tasks: true,
      messages: undefined
    })
  })

  it('sends only the all scope for --all', async () => {
    await invoke(new Map([['all', true]]))
    expect(callMock).toHaveBeenCalledWith('orchestration.reset', {
      all: true,
      tasks: undefined,
      messages: undefined
    })
  })

  it.each([
    new Map<string, string | boolean>([
      ['tasks', true],
      ['messages', true]
    ]),
    new Map<string, string | boolean>([
      ['all', true],
      ['tasks', true]
    ])
  ])('rejects multiple reset scopes before calling the runtime', async (flags) => {
    await expect(invoke(flags)).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
  })
})

describe('orchestration task-list brief output', () => {
  it('requests server-side brief and falls back client-side for older runtimes', async () => {
    callMock.mockReset().mockResolvedValue({
      result: {
        tasks: [{ id: 'task_1', spec: `First line\n${'detail '.repeat(40)}`, status: 'ready' }],
        count: 1
      }
    })
    vi.mocked(printResult).mockClear()
    await ORCHESTRATION_HANDLERS['orchestration task-list']({
      flags: new Map([['brief', true]]),
      client: { call: callMock },
      json: true
    } as never)
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.taskList',
      expect.objectContaining({ brief: true })
    )
    const response = vi.mocked(printResult).mock.calls[0]?.[0] as {
      result: { tasks: { spec: string; spec_truncated: boolean }[] }
    }
    expect(response.result.tasks[0].spec).toHaveLength(160)
    expect(response.result.tasks[0].spec_truncated).toBe(true)
  })

  it('passes server-abbreviated rows through untouched', async () => {
    const serverTasks = [
      { id: 'task_1', spec: 'already brief…', status: 'ready', spec_truncated: true }
    ]
    callMock.mockReset().mockResolvedValue({ result: { tasks: serverTasks, count: 1 } })
    vi.mocked(printResult).mockClear()
    await ORCHESTRATION_HANDLERS['orchestration task-list']({
      flags: new Map([['brief', true]]),
      client: { call: callMock },
      json: true
    } as never)
    const response = vi.mocked(printResult).mock.calls[0]?.[0] as {
      result: { tasks: { spec: string; spec_truncated: boolean }[] }
    }
    expect(response.result.tasks).toBe(serverTasks)
  })
})
