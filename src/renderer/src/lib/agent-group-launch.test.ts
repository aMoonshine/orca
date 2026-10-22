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
      case 'orchestration.workerStart': {
        const receipt = options.receipts?.[index]
        index += 1
        return (
          receipt ?? {
            state: 'ready',
            taskId: `task-${index}`,
            dispatchId: `dispatch-${index}`
          }
        )
      }
      default:
        throw new Error(`Unexpected RPC ${method}`)
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture responses mirror the named RPC contracts consumed by the controller.
  const controller = new AgentGroupController(rpc as GroupRpc, vi.fn(), options.run ?? null)
  return { controller, calls, rpc }
}

describe('agent group launch', () => {
  it('sends exact mixed models and explicit Codex high effort without adding defaults', async () => {
    const { controller, calls } = fixture()
    await controller.launch('workspace', 'swarm', 'Goal', [
      { ...workers[0], model: 'gpt-6.1-sol', effort: 'high' },
      { ...workers[1], model: 'sonnet' },
      { ...workers[0], id: 'worker-c', agent: 'opencode', model: 'opencode/big-pickle' }
    ])
    expect(
      calls.filter((call) => call.method === 'orchestration.workerStart').map((call) => call.params)
    ).toEqual([
      {
        from: 'term-1',
        run: 'run-1',
        agent: 'codex',
        model: 'gpt-6.1-sol',
        effort: 'high',
        worktree: 'current',
        task: 'task-0'
      },
      {
        from: 'term-1',
        run: 'run-1',
        agent: 'claude',
        model: 'sonnet',
        worktree: 'current',
        task: 'task-1'
      },
      {
        from: 'term-1',
        run: 'run-1',
        agent: 'opencode',
        model: 'opencode/big-pickle',
        worktree: 'current',
        task: 'task-2'
      }
    ])
    expect(controller.getSnapshot().error).toBeNull()
  })

  it('keeps an unsupported provider on its CLI defaults without model or effort fields', async () => {
    const { controller, calls } = fixture()
    await controller.launch('workspace', 'swarm', 'Goal', [
      { ...workers[0], agent: 'gemini', model: '' }
    ])
    const starts = calls.filter((call) => call.method === 'orchestration.workerStart')
    expect(starts).toHaveLength(1)
    expect(starts[0].params).toMatchObject({ agent: 'gemini' })
    expect(starts[0].params).not.toHaveProperty('model')
    expect(starts[0].params).not.toHaveProperty('effort')
    expect(controller.getSnapshot().error).toBeNull()
  })

  const invalidWorkers: GroupWorker[] = [
    { ...workers[0], agent: 'opencode', model: 'opencode/big-pickle', effort: 'high' },
    { ...workers[0], model: 'gpt-6.1-sol', effort: 'invalid' },
    { ...workers[0], effort: 'high' },
    { ...workers[0], agent: 'gemini', model: 'explicit-model' }
  ]
  it.each(invalidWorkers)(
    'refuses invalid $agent/$model/$effort before creating any resources',
    async (worker) => {
      const { controller, calls } = fixture()
      await controller.launch('workspace', 'swarm', 'Goal', [workers[0], worker])
      expect(controller.getSnapshot().error).toBeTruthy()
      expect(calls).toEqual([])
    }
  )

  it('refuses an invalid effort in an existing Run before task or worker writes', async () => {
    const { controller, calls } = fixture({
      run: { id: 'run-1', from: 'term-1', mode: 'swarm', phaseId: 'coordination' }
    })
    await controller.launch('workspace', 'swarm', 'Goal', [
      workers[0],
      { ...workers[1], agent: 'opencode', model: 'opencode/big-pickle', effort: 'high' }
    ])
    expect(controller.getSnapshot().error).toContain('does not support effort high')
    expect(
      calls.some(({ method }) =>
        ['orchestration.taskCreate', 'orchestration.workerStart'].includes(method)
      )
    ).toBe(false)
  })
  it('refreshes durable task state when readiness times out', async () => {
    const options: { tasks: unknown[]; receipts: unknown[] } = {
      tasks: [],
      receipts: [{ state: 'failed', lastError: 'timeout' }]
    }
    const { controller, calls } = fixture(options)
    controller.subscribe(() => {
      if (controller.getSnapshot().receipts.some((receipt) => receipt.state === 'failed')) {
        options.tasks = [{ id: 'task-0', status: 'failed', spec: 'Review', result: null }]
      }
    })
    await controller.launch('workspace', 'swarm', 'Goal', workers)
    expect(controller.getSnapshot().tasks).toEqual(options.tasks)
    expect(controller.getSnapshot().error).toBe('timeout')
    expect(calls.filter((call) => call.method === 'orchestration.workerStart')).toHaveLength(1)
  })

  it('creates a mode-bearing Run and starts the entire wave on its coordinator', async () => {
    const { controller, calls } = fixture()
    await controller.launch('folder:example', 'swarm', 'Review this project', workers)
    expect(controller.getSnapshot().error).toBeNull()
    expect(calls.find((call) => call.method === 'terminal.create')?.params).toMatchObject({
      worktree: 'id:folder:example',
      rendererBacked: true
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
