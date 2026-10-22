import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext } from '../../../core'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import {
  ADDRESS_X,
  createSessionCallerHarness,
  orchestrationRequest,
  SESSION_X,
  SESSION_Y,
  type SessionCallerHarness
} from '../../../orchestration-session-caller-test-fixture'
import { ORCHESTRATION_RUN_WORK_MODE_METHODS } from './run-work-mode-methods'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const COORDINATOR = 'term_coord'
const WORKER = 'term_worker'
const COORDINATOR_PANE = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TOKEN = 'test-launch-token'
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex')
const MUTATIONS = ['orchestration.runModeSet', 'orchestration.runPhaseAdvance'] as const

async function call(name: string, params: Record<string, unknown>, ctx: RpcContext) {
  const method = eraseRpcMethods(ORCHESTRATION_RUN_WORK_MODE_METHODS).find(
    (candidate) => candidate.name === name
  )
  if (!method) {
    throw new Error(`Method not found: ${name}`)
  }
  return method.handler(method.params?.parse(params), ctx)
}

describe('Run mode RPC terminal authority', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService(null, undefined, {
      attestAgentHookCompatibilityAuthority: ({ paneKey, launchTokenHash }) =>
        launchTokenHash === TOKEN_HASH ? { paneKey, source: 'hydrated_commitment' } : null
    })
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === COORDINATOR ? COORDINATOR_PANE : WORKER_PANE
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => ({
      runtimeId: 'test-runtime',
      terminalHandle: handle,
      ptyId: `pty-${handle}`,
      worktreeId: 'folder-workspace',
      processIncarnation: `incarnation-${handle}`,
      paneKey: runtime.getTerminalPaneKey(handle),
      launchTokenHash: TOKEN_HASH,
      hostScope: { kind: 'local', hostId: 'local' }
    }))
    runId = db.createRun({
      objective: 'Mode RPC authority',
      coordinatorHandle: COORDINATOR,
      coordinatorPaneKey: COORDINATOR_PANE,
      mode: 'swarm'
    }).id
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  function context(handle: string): RpcContext {
    return {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: handle,
        paneKey: handle === COORDINATOR ? COORDINATOR_PANE : WORKER_PANE,
        launchToken: TOKEN
      }
    }
  }

  it.each(MUTATIONS)('fences %s with a forged coordinator handle', async (method) => {
    const before = db.getRunWorkMode(runId)
    const phases = db.listRunPhaseEvents(runId)
    await expect(
      call(method, { from: COORDINATOR, id: runId, mode: 'solo' }, context(WORKER))
    ).rejects.toMatchObject({ code: 'consumer_fenced', data: { effectsApplied: false } })
    expect(db.getRunWorkMode(runId)).toEqual(before)
    expect(db.listRunPhaseEvents(runId)).toEqual(phases)
  })

  it.each(MUTATIONS)('fences %s from an unbound worker', async (method) => {
    await expect(
      call(method, { from: WORKER, id: runId, mode: 'solo' }, context(WORKER))
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(db.getRunWorkMode(runId)).toMatchObject({ mode: 'swarm', phaseId: 'coordination' })
    expect(db.listRunPhaseEvents(runId)).toHaveLength(1)
  })

  it('allows an attested coordinator to set and advance the mode', async () => {
    await expect(
      call('orchestration.runModeSet', { from: COORDINATOR, mode: 'fusion' }, context(COORDINATOR))
    ).resolves.toMatchObject({ workMode: { mode: 'fusion', phaseId: 'panel' } })
    await expect(
      call('orchestration.runPhaseAdvance', { from: COORDINATOR }, context(COORDINATOR))
    ).resolves.toMatchObject({ workMode: { mode: 'fusion', phaseId: 'judge' } })
  })

  it.each(MUTATIONS)(
    'refuses %s with a starting writer and preserves phase history',
    async (method) => {
      db.advanceRunPhase({ runId })
      db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: 10,
        taskRunId: runId,
        taskSpec: 'writer still starting',
        startOptions: {}
      })
      const before = db.getRunWorkMode(runId)
      const phases = db.listRunPhaseEvents(runId)
      await expect(
        call(method, { from: COORDINATOR, mode: 'solo' }, context(COORDINATOR))
      ).rejects.toMatchObject({ code: 'run_phase_workers_active', data: { effectsApplied: false } })
      expect(db.getRunWorkMode(runId)).toEqual(before)
      expect(db.listRunPhaseEvents(runId)).toEqual(phases)
    }
  )

  it('allows catch-up round two and rejects round three without recording another event', async () => {
    const advance = () =>
      call('orchestration.runPhaseAdvance', { from: COORDINATOR }, context(COORDINATOR))
    await advance()
    await expect(advance()).resolves.toMatchObject({ workMode: { phaseId: 'catchup', round: 1 } })
    await expect(advance()).resolves.toMatchObject({ workMode: { phaseId: 'catchup', round: 2 } })
    const phases = db.listRunPhaseEvents(runId)
    await expect(advance()).rejects.toMatchObject({ code: 'phase_round_exhausted' })
    expect(db.getRunWorkMode(runId)).toMatchObject({ phaseId: 'catchup', round: 2 })
    expect(db.listRunPhaseEvents(runId)).toEqual(phases)
  })

  it('keeps explicit Run mode queries available to workers', async () => {
    await expect(
      call('orchestration.runMode', { from: WORKER, id: runId }, context(WORKER))
    ).resolves.toMatchObject({ workMode: { mode: 'swarm', phaseId: 'coordination' } })
    expect(db.listRunPhaseEvents(runId)).toHaveLength(1)
  })
})

describe('Run mode RPC session authority at dispatch', () => {
  let h: SessionCallerHarness
  let runId: string

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
    runId = h.db.createRun({
      objective: 'Session mode coordinator',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: SESSION_X,
      mode: 'swarm'
    }).id
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  it.each(MUTATIONS)(
    'allows %s from the coordinator session without a declared handle',
    async (method) => {
      const response = await h.dispatch(
        orchestrationRequest(method, { mode: 'fusion' }, { sessionId: SESSION_X })
      )
      expect(response).toMatchObject({ ok: true })
      expect(h.db.getRunWorkMode(runId).phaseId).toBe(
        method === 'orchestration.runModeSet' ? 'panel' : 'implementation'
      )
    }
  )

  it.each(MUTATIONS)('refuses %s from a session declaring another caller', async (method) => {
    const response = await h.dispatch(
      orchestrationRequest(
        method,
        { from: ADDRESS_X, id: runId, mode: 'solo' },
        { sessionId: SESSION_Y }
      )
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(h.db.getRunWorkMode(runId)).toMatchObject({ mode: 'swarm', phaseId: 'coordination' })
    expect(h.db.listRunPhaseEvents(runId)).toHaveLength(1)
  })

  it('reads the current mode as the coordinator session', async () => {
    expect(
      await h.dispatch(orchestrationRequest('orchestration.runMode', {}, { sessionId: SESSION_X }))
    ).toMatchObject({ ok: true, result: { workMode: { mode: 'swarm' } } })
  })
})
