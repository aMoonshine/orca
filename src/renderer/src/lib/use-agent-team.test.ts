// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
import { useAgentTeam } from './use-agent-team'
import { teamSessionKey } from './agent-team/session-state'

const worktreeId = 'folder:polled-team'
const target = { kind: 'local' as const }
let handles: string[]
let runId: string | null
const closed = new Set<string>()

function addTab(entityId: string) {
  return useAppStore.getState().createUnifiedTab(worktreeId, 'terminal', { entityId })
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  localStorage.setItem(
    teamSessionKey(target, worktreeId),
    JSON.stringify({ tabId: 'master', handle: 'master' })
  )
  runId = 'run'
  handles = ['worker', 'closed']
  closed.clear()
  closed.add('closed')
  useAppStore.setState({
    activeWorktreeId: worktreeId,
    groupsByWorktree: {},
    unifiedTabsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {}
  })
  mocks.rpc.mockImplementation(
    async (_target: unknown, method: string, params: { terminal?: string }) => {
      if (method === 'orchestration.runCurrent') {
        return { run: runId ? { id: runId } : null }
      }
      if (method === 'orchestration.runMode') {
        return { workMode: { mode: 'swarm', phaseId: 'implementation' } }
      }
      if (method === 'orchestration.taskList') {
        return { tasks: [] }
      }
      if (method === 'orchestration.workerList') {
        return {
          workers: handles.map((handle) => ({
            dispatchId: handle,
            taskId: handle,
            agentTerminalHandle: handle
          }))
        }
      }
      if (method === 'terminal.show' && params.terminal && !closed.has(params.terminal)) {
        return { terminal: { tabId: params.terminal, worktreeId } }
      }
      throw new Error('Terminal unavailable')
    }
  )
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('automatic team panel arrangement', () => {
  it('cancels handle discovery when the last subscriber leaves', async () => {
    localStorage.setItem(teamSessionKey(target, worktreeId), JSON.stringify({ tabId: 'master' }))
    let finish: ((result: unknown) => void) | undefined
    mocks.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const monitor = renderHook(() => useAgentTeam(target, worktreeId, true))
    await act(async () => {})
    expect(mocks.rpc.mock.calls[0][1]).toBe('terminal.list')
    const signal: AbortSignal = mocks.rpc.mock.calls[0][3].signal
    monitor.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => {
      finish?.({ terminals: [{ tabId: 'master', handle: 'master' }] })
    })
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().groupsByWorktree[worktreeId]).toBeUndefined()
  })

  it('requests remote workers and preserves partial-host diagnostics beside usable tasks', async () => {
    const original = mocks.rpc.getMockImplementation()!
    mocks.rpc.mockImplementation(async (scope, method, params, options) => {
      if (method === 'orchestration.workerList') {
        expect(params.includeRemote).toBe(true)
        return {
          workers: [
            {
              dispatchId: 'remote-worker',
              taskId: 'task',
              agentTerminalHandle: null,
              projection: {
                attention: { requiresAction: true },
                liveness: { verdict: 'unverifiable' }
              }
            }
          ],
          partialHostErrors: [
            {
              environmentId: 'host-a',
              name: 'Remote A',
              code: 'host_unavailable',
              dispatchIds: ['remote-worker']
            }
          ]
        }
      }
      return original(scope, method, params, options)
    })
    const monitor = renderHook(() => useAgentTeam(target, worktreeId))
    await act(async () => {})
    expect(monitor.result.current.run?.id).toBe('run')
    expect(monitor.result.current.workers).toHaveLength(1)
    expect(monitor.result.current.error).toBe('host-a: host_unavailable')
    mocks.rpc.mockImplementation(original)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(monitor.result.current.error).toBeNull()
    expect(monitor.result.current.run?.id).toBe('run')
  })

  it('shares polling and arrangement between board and monitor until the last subscriber leaves', async () => {
    addTab('master')
    addTab('worker')
    const board = renderHook(() => useAgentTeam({ kind: 'local' }, worktreeId))
    const monitor = renderHook(() => useAgentTeam({ kind: 'local' }, worktreeId, true))
    await act(async () => {})
    const polls = () =>
      mocks.rpc.mock.calls.filter((call) => call[1] === 'orchestration.runCurrent').length
    expect(polls()).toBe(1)
    expect(board.result.current).toBe(monitor.result.current)
    expect(board.result.current.run?.id).toBe('run')
    expect(useAppStore.getState().groupsByWorktree[worktreeId]).toHaveLength(2)
    expect(
      mocks.rpc.mock.calls.filter(
        (call) => call[1] === 'terminal.show' && call[2].terminal === 'master'
      )
    ).toHaveLength(1)
    useAppStore.getState().setTabGroupSplitRatio(worktreeId, '', 0.74)
    const manual = useAppStore.getState().layoutByWorktree[worktreeId]
    board.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(polls()).toBe(2)
    expect(useAppStore.getState().layoutByWorktree[worktreeId]).toBe(manual)
    monitor.unmount()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(polls()).toBe(2)
  })

  it('isolates runtime targets and folder workspaces and drops old snapshots on target changes', async () => {
    const remote = { kind: 'environment' as const, environmentId: 'host-a' }
    const otherWorkspace = 'folder:other-team'
    for (const [scope, workspace] of [
      [remote, worktreeId],
      [target, otherWorkspace]
    ] as const) {
      localStorage.setItem(
        teamSessionKey(scope, workspace),
        JSON.stringify({ tabId: 'other', handle: 'other' })
      )
    }
    mocks.rpc.mockImplementation(async (scope, method, params) => {
      if (method === 'orchestration.runCurrent') {
        return { run: { id: `${scope.kind}:${params.from}` } }
      }
      if (method === 'orchestration.runMode') {
        return { workMode: { mode: 'swarm', phaseId: 'implementation' } }
      }
      return method === 'orchestration.taskList' ? { tasks: [] } : { workers: [] }
    })
    const local = renderHook(() => useAgentTeam(target, worktreeId))
    const paired = renderHook(() => useAgentTeam(remote, worktreeId))
    const folder = renderHook(() => useAgentTeam(target, otherWorkspace))
    await act(async () => {})
    expect(local.result.current.run?.id).toBe('local:master')
    expect(paired.result.current.run?.id).toBe('environment:other')
    expect(folder.result.current.run?.id).toBe('local:other')
    expect(
      mocks.rpc.mock.calls.filter((call) => call[1] === 'orchestration.runCurrent')
    ).toHaveLength(3)
    const switched = renderHook(({ workspace }) => useAgentTeam(target, workspace), {
      initialProps: { workspace: worktreeId }
    })
    expect(switched.result.current.run?.id).toBe('local:master')
    switched.rerender({ workspace: 'folder:missing' })
    expect(switched.result.current.run).toBeNull()
    expect(local.result.current.run?.id).toBe('local:master')
  })

  it('cancels an abandoned poll without publishing into its replacement subscription', async () => {
    let finish: ((result: unknown) => void) | undefined
    mocks.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const abandoned = renderHook(() => useAgentTeam(target, worktreeId, true))
    await act(async () => {})
    const signal: AbortSignal = mocks.rpc.mock.calls[0][3].signal
    abandoned.unmount()
    expect(signal.aborted).toBe(true)
    runId = 'replacement-run'
    const replacement = renderHook(() => useAgentTeam(target, worktreeId))
    await act(async () => {})
    expect(replacement.result.current.run?.id).toBe('replacement-run')
    const calls = mocks.rpc.mock.calls.length
    await act(async () => {
      finish?.({ run: { id: 'abandoned-run' } })
    })
    expect(replacement.result.current.run?.id).toBe('replacement-run')
    expect(mocks.rpc.mock.calls).toHaveLength(calls)
    expect(useAppStore.getState().groupsByWorktree[worktreeId]).toBeUndefined()
  })

  it('clears missing runs and sessions and rebalances the same tabs for a new run', async () => {
    addTab('master')
    addTab('worker')
    const monitor = renderHook(() => useAgentTeam(target, worktreeId, true))
    await act(async () => {})
    useAppStore.getState().setTabGroupSplitRatio(worktreeId, '', 0.77)
    runId = 'new-run'
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(monitor.result.current.run?.id).toBe('new-run')
    const layout = useAppStore.getState().layoutByWorktree[worktreeId]
    expect(layout.type === 'split' && layout.ratio).toBe(0.5)
    runId = null
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(monitor.result.current).toEqual({ run: null, tasks: [], workers: [], error: null })
    runId = 'returned-run'
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(monitor.result.current.run?.id).toBe('returned-run')
    localStorage.removeItem(teamSessionKey(target, worktreeId))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(monitor.result.current).toEqual({ run: null, tasks: [], workers: [], error: null })
  })

  it('includes the master and preserves manual resize until resolved membership changes', async () => {
    const master = addTab('master')
    const worker = addTab('worker')
    let unmount = () => {}
    await act(async () => {
      unmount = renderHook(() => useAgentTeam(target, worktreeId, true)).unmount
    })
    const initial = useAppStore.getState()
    expect(initial.groupsByWorktree[worktreeId]).toHaveLength(2)
    expect(initial.getTab(master.id)?.groupId).not.toBe(initial.getTab(worker.id)?.groupId)
    initial.setTabGroupSplitRatio(worktreeId, '', 0.73)
    const manual = useAppStore.getState().layoutByWorktree[worktreeId]
    unmount()
    await act(async () => {
      renderHook(() => useAgentTeam(target, worktreeId, true))
    })
    expect(useAppStore.getState().layoutByWorktree[worktreeId]).toBe(manual)
    handles = handles.toReversed()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(useAppStore.getState().layoutByWorktree[worktreeId]).toBe(manual)

    handles.push('replacement')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(useAppStore.getState().layoutByWorktree[worktreeId]).toBe(manual)
    addTab('replacement')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(useAppStore.getState().groupsByWorktree[worktreeId]).toHaveLength(3)
    const layout = useAppStore.getState().layoutByWorktree[worktreeId]
    expect(layout.type === 'split' && layout.ratio).toBeCloseTo(2 / 3)

    useAppStore
      .getState()
      .closeUnifiedTab(worker.id, { terminalRetirementHandled: true, recordInteraction: false })
    closed.add('worker')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    const afterClose = useAppStore.getState().layoutByWorktree[worktreeId]
    expect(useAppStore.getState().groupsByWorktree[worktreeId]).toHaveLength(2)
    expect(afterClose.type === 'split' && afterClose.ratio).toBe(0.5)
    useAppStore.getState().setTabGroupSplitRatio(worktreeId, '', 0.62)
    const resized = useAppStore.getState().layoutByWorktree[worktreeId]
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(useAppStore.getState().layoutByWorktree[worktreeId]).toBe(resized)
  })
})
