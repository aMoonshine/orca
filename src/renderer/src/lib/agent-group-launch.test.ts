import { describe, expect, it, vi } from 'vitest'
import {
  AgentGroupController,
  validateGroupWave,
  type GroupRpc,
  type GroupRun,
  type GroupWorker
} from './agent-group-launch'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

const workers: GroupWorker[] = [
  { id: 'worker-a', agent: 'codex', spec: 'Review the parser. Report findings.', claims: '' },
  { id: 'worker-b', agent: 'claude', spec: 'Review tests. Report gaps.', claims: '' }
]

function fixture(
  options: { receipts?: unknown[]; tasks?: unknown[]; run?: GroupRun; reject?: string } = {}
) {
  const run = options.run ?? { id: 'run-1', from: 'term-1', mode: 'swarm', phaseId: 'coordination' }
  const calls: { method: string; params: unknown }[] = []
  let index = 0
  const rpc = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
    calls.push({ method, params })
    if (method === options.reject) {
      throw new Error('Connection lost; outcome unknown')
    }
    switch (method) {
      case 'terminal.create':
        return { terminal: { handle: run.from } }
      case 'orchestration.runCreate':
      case 'orchestration.runCurrent':
        return { run: { id: run.id } }
      case 'orchestration.runMode':
        return { workMode: run }
      case 'orchestration.taskList':
        return { tasks: options.tasks ?? [] }
      case 'orchestration.taskCreate':
        return { task: { id: `task-${index}` } }
      case 'orchestration.runPhaseAdvance':
        return { workMode: { ...run, phaseId: 'implementation' } }
      case 'orchestration.workerStart':
        return (
          options.receipts?.[index++] ?? {
            state: 'ready',
            taskId: `task-${index}`,
            dispatchId: `dispatch-${index}`
          }
        )
      default:
        throw new Error(`Unexpected RPC ${method}`)
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture responses mirror the named RPC contracts consumed by the controller.
  const controller = new AgentGroupController(rpc as GroupRpc, vi.fn(), options.run ?? null)
  return { controller, calls, rpc }
}

describe('agent group launch', () => {
  it('creates a mode-bearing Run and starts the entire wave on its coordinator', async () => {
    const { controller, calls } = fixture()
    await controller.launch('folder:example', 'swarm', 'Review this project', workers)
    expect(controller.getSnapshot().error).toBeNull()
    expect(calls.find((call) => call.method === 'terminal.create')?.params).toMatchObject({
      worktree: 'id:folder:example'
    })
    expect(calls.find((call) => call.method === 'orchestration.runCreate')?.params).toMatchObject({
      mode: 'swarm',
      from: 'term-1'
    })
    expect(
      calls.filter((call) => call.method === 'orchestration.workerStart').map((call) => call.params)
    ).toEqual([
      expect.objectContaining({
        agent: 'codex',
        run: 'run-1',
        from: 'term-1',
        worktree: 'current'
      }),
      expect.objectContaining({
        agent: 'claude',
        run: 'run-1',
        from: 'term-1',
        worktree: 'current'
      })
    ])
  })

  it('ignores a second click while a launch is in progress', async () => {
    const { controller, calls } = fixture()
    await Promise.all([
      controller.launch('workspace', 'swarm', 'Goal', workers),
      controller.launch('workspace', 'swarm', 'Goal', workers)
    ])
    expect(calls.filter((call) => call.method === 'orchestration.runCreate')).toHaveLength(1)
  })

  it('stops the queue and preserves a failed receipt after a successful start', async () => {
    const { controller, calls } = fixture({
      receipts: [
        { state: 'ready', dispatchId: 'first' },
        { state: 'outcome_unknown', dispatchId: 'second', lastError: 'Turn unobserved' }
      ]
    })
    await controller.launch('workspace', 'swarm', 'Goal', [...workers, workers[0]])
    expect(calls.filter((call) => call.method === 'orchestration.workerStart')).toHaveLength(2)
    expect(controller.getSnapshot().receipts).toHaveLength(2)
    expect(controller.getSnapshot().error).toBe('Turn unobserved')
  })

  it('refuses a stale host without work-mode support before launching workers', async () => {
    const { controller, calls } = fixture({ reject: 'orchestration.runMode' })
    await controller.launch('workspace', 'swarm', 'Goal', workers)
    expect(calls.some((call) => call.method === 'orchestration.workerStart')).toBe(false)
    expect(controller.getSnapshot().run?.id).toBe('run-1')
  })

  it('does not advance or duplicate outstanding work', async () => {
    const { controller, calls } = fixture({
      run: { id: 'run-1', from: 'term-1', mode: 'swarm', phaseId: 'coordination' },
      tasks: [{ id: 'task-1', status: 'dispatched', spec: 'Working', result: null }]
    })
    await controller.advance()
    await controller.launch('workspace', 'swarm', 'Goal', workers)
    expect(
      calls.some((call) =>
        ['orchestration.workerStart', 'orchestration.runPhaseAdvance'].includes(call.method)
      )
    ).toBe(false)
    expect(controller.getSnapshot().error).toContain('settle')
  })

  it('places orchestrator implementation workers in separate worktrees', async () => {
    const { controller, calls } = fixture({
      run: { id: 'run-1', from: 'term-1', mode: 'orchestrator', phaseId: 'implementation' }
    })
    await controller.launch(
      'workspace',
      'orchestrator',
      'Goal',
      workers.map((worker) => ({ ...worker, claims: 'src' }))
    )
    const starts = calls.filter((call) => call.method === 'orchestration.workerStart')
    expect(starts).toHaveLength(2)
    expect(starts[0].params).toMatchObject({ worktree: 'new-child', claims: 'src' })
    expect(starts[0].params).not.toEqual(starts[1].params)
  })

  it('validates phase limits and writer ownership before any effects', () => {
    expect(() => validateGroupWave('fusion', 'integration', workers)).toThrow('number')
    expect(() => validateGroupWave('swarm', 'implementation', workers)).toThrow('file paths')
    expect(() => validateGroupWave('swarm', 'coordination', Array(7).fill(workers[0]))).toThrow(
      'number'
    )
    expect(() =>
      validateGroupWave('swarm', 'coordination', Array(6).fill(workers[0]))
    ).not.toThrow()
  })
})
