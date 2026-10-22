import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { AGENT_PROMPT_STALLED_ERROR } from '../agent-prompt-submission-verification'

type WorkerFixture = {
  dispatchId: string
  handle: string
  paneKey: string
  processIncarnation: string
}

let db: OrchestrationDb | undefined
let dir: string | undefined

afterEach(() => {
  db?.close()
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
  db = undefined
  dir = undefined
})

describe('Task/Dispatch lifecycle guards', () => {
  it('releases failed-start claims so a legitimate retry can claim the same paths', () => {
    const database = createDatabase()
    const started = database.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 10,
      taskRunId: 'run_legacy_local',
      taskSpec: 'retry claims',
      startOptions: {}
    })
    claimFiles(database, started.dispatch.id)
    database.failWorkerStart(started.dispatch.id, 'agent_readiness', 'agent refused')

    expect(database.listFileClaimsForDispatch(started.dispatch.id)).toEqual([])
    const retry = database.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 10,
      taskId: started.task.id,
      retryOf: started.dispatch.id,
      startOptions: {}
    })
    expect(claimFiles(database, retry.dispatch.id).refused).toEqual([])
  })

  it.each([
    'stop',
    'abandon',
    'exit',
    'complete',
    'missing-terminal',
    'report-success',
    'report-failure'
  ] as const)('releases only the ended dispatch claims after %s', (operation) => {
    const database = createDatabase()
    const task = database.createTask({ runId: 'run_legacy_local', spec: `${operation} claims` })
    const worker = startWorker(database, task.id, operation)
    claimFiles(database, worker.dispatchId)
    const peerClaims = claimFiles(database, 'live_peer', ['src/peer.ts']).granted

    if (operation === 'stop') {
      database.beginWorkerStop(worker.dispatchId, 'runtime_test')
      expect(database.listFileClaimsForDispatch(worker.dispatchId)).toHaveLength(1)
      database.settleWorkerStop(worker.dispatchId)
    } else if (operation === 'abandon') {
      database.abandonWorkerDispatch(worker.dispatchId, 'runtime_test')
    } else if (operation === 'exit') {
      database.failDispatch(worker.dispatchId, 'exited', { workerProcessExited: true })
    } else if (operation === 'missing-terminal') {
      database.reconcileMissingWorkerTerminal(worker.dispatchId, 'terminal proven missing')
    } else if (operation === 'report-success' || operation === 'report-failure') {
      expect(
        database.settleWorkerReport({
          taskId: task.id,
          dispatchId: worker.dispatchId,
          outcome: operation === 'report-success' ? 'succeeded' : 'failed',
          result: 'settled report'
        }).action
      ).toBe('settled')
    } else {
      database.completeDispatch(worker.dispatchId)
    }

    expect(database.listFileClaimsForDispatch(worker.dispatchId)).toEqual([])
    expect(database.listFileClaimsForDispatch('live_peer')).toEqual(peerClaims)
  })

  it('preserves claims while start and stop outcomes remain unknown', () => {
    const database = createDatabase()
    const started = database.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 10,
      taskRunId: 'run_legacy_local',
      taskSpec: 'uncertain claims',
      startOptions: {}
    })
    const claims = claimFiles(database, started.dispatch.id).granted
    database.markWorkerStartUnknown(started.dispatch.id, 'prompt_delivery', 'response lost')
    expect(database.listFileClaimsForDispatch(started.dispatch.id)).toEqual(claims)
    database.beginWorkerStop(started.dispatch.id, 'runtime_test')
    database.markWorkerStopUnknown(started.dispatch.id, 'response lost')
    expect(database.listFileClaimsForDispatch(started.dispatch.id)).toEqual(claims)
    expect(() => database.failDispatch(started.dispatch.id, 'unsafe retry')).toThrow()
    expect(database.listFileClaimsForDispatch(started.dispatch.id)).toEqual(claims)
  })

  it('keeps a legacy unobserved prompt claim until its worker report settles', () => {
    const database = createDatabase()
    const started = database.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 10,
      taskRunId: 'run_legacy_local',
      taskSpec: 'legacy prompt claims',
      startOptions: {}
    })
    const claims = claimFiles(database, started.dispatch.id).granted
    database.failWorkerStart(started.dispatch.id, 'prompt_delivery', AGENT_PROMPT_STALLED_ERROR)
    expect(database.listFileClaimsForDispatch(started.dispatch.id)).toEqual(claims)
    expect(
      database.settleWorkerReport({
        taskId: started.task.id,
        dispatchId: started.dispatch.id,
        outcome: 'failed',
        result: 'worker report proves settlement'
      }).action
    ).toBe('settled')
    expect(database.listFileClaimsForDispatch(started.dispatch.id)).toEqual([])
  })

  it('releases assignment claims without changing user terminal takeover', () => {
    const database = createDatabase()
    const task = database.createTask({ runId: 'run_legacy_local', spec: 'user takeover claims' })
    const worker = startWorker(database, task.id, 'takeover')
    const claims = claimFiles(database, worker.dispatchId).granted
    database.markWorkerTerminalUserOwned(worker.paneKey)
    const terminal = database.getWorkerTerminalResourceByOwner(worker.dispatchId)
    expect(terminal?.ownership_state).toBe('user_owned')
    expect(database.listFileClaimsForDispatch(worker.dispatchId)).toEqual(claims)
    database.abandonWorkerDispatch(worker.dispatchId, 'runtime_test')
    expect(database.listFileClaimsForDispatch(worker.dispatchId)).toEqual([])
    expect(database.getWorkerTerminalResourceByOwner(worker.dispatchId)).toEqual(terminal)
  })

  it('rolls back failed-start lifecycle changes if claim release fails', () => {
    const database = createDatabase()
    const started = database.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 10,
      taskRunId: 'run_legacy_local',
      taskSpec: 'atomic claim release',
      startOptions: {}
    })
    const claims = claimFiles(database, started.dispatch.id).granted
    sqliteFor(database).exec(
      `CREATE TRIGGER reject_claim_release BEFORE DELETE ON worker_file_claims BEGIN SELECT RAISE(ABORT, 'forced claim release failure'); END;`
    )

    expect(() =>
      database.failWorkerStart(started.dispatch.id, 'agent_readiness', 'refused')
    ).toThrow('forced claim release failure')
    expect(database.getWorkerDispatch(started.dispatch.id)?.state).toBe('starting')
    expect(database.getDispatchContextById(started.dispatch.id)?.status).toBe('pending')
    expect(database.getTask(started.task.id)?.status).toBe('dispatched')
    expect(database.listFileClaimsForDispatch(started.dispatch.id)).toEqual(claims)
  })

  it('rejects a worker report while another supervised Dispatch is active', () => {
    const database = createDatabase()
    const task = database.createTask({ runId: 'run_legacy_local', spec: 'legacy supervised split' })
    const first = startWorker(database, task.id, 'first')
    sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    const second = startWorker(database, task.id, 'second')

    expect(
      database.settleWorkerReport({
        taskId: task.id,
        dispatchId: second.dispatchId,
        outcome: 'succeeded',
        result: 'must wait for first'
      })
    ).toMatchObject({ action: 'rejected', code: 'inactive_dispatch' })
    expect(database.getTask(task.id)?.status).toBe('dispatched')
    expect(database.getDispatchContextById(first.dispatchId)?.status).toBe('dispatched')
    expect(database.getDispatchContextById(second.dispatchId)?.status).toBe('dispatched')
    expect(database.getWorkerDispatch(first.dispatchId)?.state).toBe('ready')
    expect(database.getWorkerDispatch(second.dispatchId)?.state).toBe('ready')
  })

  it.each(['succeeded', 'failed'] as const)(
    'settles context-only legacy siblings after a %s worker report',
    (outcome) => {
      const database = createDatabase()
      const task = database.createTask({ runId: 'run_legacy_local', spec: 'legacy mixed split' })
      const contextOnly = createRootDispatch(database, task.id, 'term_context')
      sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
      const worker = startWorker(database, task.id, 'reporter')

      expect(
        database.settleWorkerReport({
          taskId: task.id,
          dispatchId: worker.dispatchId,
          outcome,
          result: `${outcome} result`
        })
      ).toEqual({ action: 'settled', outcome, duplicate: false })
      const expectedStatus = outcome === 'succeeded' ? 'completed' : 'failed'
      expect(database.getTask(task.id)?.status).toBe(expectedStatus)
      expect(database.getDispatchContextById(contextOnly.id)).toMatchObject({
        status: expectedStatus,
        capability_revoked_at: expect.any(String)
      })
      expect(database.getActiveDispatchForTerminal('term_context')).toBeUndefined()
      expect(() =>
        createRootDispatch(
          database,
          database.createTask({
            runId: 'run_legacy_local',
            spec: 'later context work'
          }).id,
          'term_context'
        )
      ).not.toThrow()
    }
  )

  it('settles a newer context-only legacy sibling after a worker report', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'reversed legacy mixed split'
    })
    const worker = startWorker(database, task.id, 'reversed_reporter')
    sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    const contextOnly = createRootDispatch(database, task.id, 'term_reversed_context')

    expect(
      database.settleWorkerReport({
        taskId: task.id,
        dispatchId: worker.dispatchId,
        outcome: 'succeeded',
        result: 'reversed sibling completed'
      })
    ).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: false })
    expect(database.getTask(task.id)?.status).toBe('completed')
    expect(database.getDispatchContextById(contextOnly.id)).toMatchObject({
      status: 'completed',
      capability_revoked_at: expect.any(String)
    })
    expect(database.getActiveDispatchForTerminal('term_reversed_context')).toBeUndefined()
  })

  it.each(['failed', 'stopped'] as const)(
    'treats abandon of an already %s worker as settled without a lifecycle conflict',
    (state) => {
      const database = createDatabase()
      const task = database.createTask({
        runId: 'run_legacy_local',
        spec: `already ${state}`
      })
      const worker = startWorker(database, task.id, `already_${state}`)
      if (state === 'failed') {
        database.failDispatch(worker.dispatchId, 'process exited', { workerProcessExited: true })
      } else {
        database.beginWorkerStop(worker.dispatchId, 'runtime-test')
        database.settleWorkerStop(worker.dispatchId)
      }

      expect(database.abandonWorkerDispatch(worker.dispatchId, 'epoch_test')).toMatchObject({
        disposition: 'already_settled',
        worker: { state }
      })
    }
  )

  it('rejects generic failure while a supervised worker remains active', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'supervised failure guard'
    })
    const worker = startWorker(database, task.id, 'guarded')

    expect(() => database.failDispatch(worker.dispatchId, 'unsafe retry')).toThrowError(
      expect.objectContaining({
        code: 'task_not_startable',
        data: { dispatchId: worker.dispatchId }
      })
    )
    expect(database.getTask(task.id)?.status).toBe('dispatched')
    expect(database.getDispatchContextById(worker.dispatchId)).toMatchObject({
      status: 'dispatched',
      failure_count: 0,
      capability_revoked_at: null
    })
    expect(database.getWorkerDispatch(worker.dispatchId)?.state).toBe('ready')
  })

  it('atomically settles worker state when a proven process exit fails its Dispatch', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'exited worker'
    })
    const worker = startWorker(database, task.id, 'exited')

    expect(
      database.failDispatch(worker.dispatchId, 'process exited', { workerProcessExited: true })
    ).toMatchObject({ status: 'failed', failure_count: 1 })
    expect(database.getTask(task.id)?.status).toBe('ready')
    expect(database.getWorkerDispatch(worker.dispatchId)).toMatchObject({
      state: 'failed',
      stage: 'process_exited',
      last_error: 'process exited'
    })
  })

  it('settles a stop-unknown worker when a positive PTY exit arrives', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'stop-unknown exited worker'
    })
    const worker = startWorker(database, task.id, 'stop_unknown_exited')

    expect(database.beginWorkerStop(worker.dispatchId, 'runtime_test').disposition).toBe('stopping')
    expect(database.markWorkerStopUnknown(worker.dispatchId, 'stop response lost').state).toBe(
      'stop_unknown'
    )

    expect(() =>
      database.failDispatch(worker.dispatchId, 'process exited', {
        workerProcessExited: true,
        terminationReason: 'exited'
      })
    ).not.toThrow()
    expect(database.getTask(task.id)?.status).toBe('blocked')
    expect(database.getDispatchContextById(worker.dispatchId)).toMatchObject({
      status: 'failed',
      termination_reason: 'exited',
      capability_revoked_at: expect.any(String)
    })
    expect(database.getWorkerDispatch(worker.dispatchId)).toMatchObject({
      state: 'failed',
      stage: 'process_exited',
      last_error: 'process exited'
    })
  })

  it('keeps a Task dispatched when missing-terminal recovery leaves another worker active', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'legacy missing-terminal split'
    })
    const missing = startWorker(database, task.id, 'missing')
    sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    const live = startWorker(database, task.id, 'live')

    database.reconcileMissingWorkerTerminal(missing.dispatchId, 'terminal missing')

    expect(database.getTask(task.id)?.status).toBe('dispatched')
    expect(database.getDispatchContextById(missing.dispatchId)).toMatchObject({
      status: 'failed',
      capability_revoked_at: expect.any(String)
    })
    expect(database.getWorkerDispatch(missing.dispatchId)?.state).toBe('abandoned')
    expect(database.getDispatchContextById(live.dispatchId)?.status).toBe('dispatched')
    expect(database.getWorkerDispatch(live.dispatchId)?.state).toBe('ready')

    database.reconcileMissingWorkerTerminal(live.dispatchId, 'second terminal missing')
    expect(database.getTask(task.id)?.status).toBe('ready')
    expect(database.getDispatchContextById(live.dispatchId)?.status).toBe('failed')
  })

  it.each(['local', 'federated'] as const)(
    'keeps a Task dispatched when a %s worker start fails beside a live worker',
    (kind) => {
      const database = createDatabase()
      const task = database.createTask({
        runId: 'run_legacy_local',
        spec: `${kind} split start failure`
      })
      const failed = database.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: {},
        ...(kind === 'federated'
          ? {
              federation: {
                environmentId: 'server-1',
                environmentName: 'worker server',
                peerFingerprint: 'peer-1',
                protocolVersion: 3
              }
            }
          : {})
      })
      sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
      const live = startWorker(database, task.id, `${kind}_live`)

      if (kind === 'local') {
        database.failWorkerStart(failed.dispatch.id, 'start_failed', 'worker failed to start')
      } else {
        database.reconcileFederatedWorkerStart({
          dispatchId: failed.dispatch.id,
          state: 'failed',
          stage: 'start_failed',
          lastError: 'worker failed to start'
        })
      }

      expect(database.getTask(task.id)?.status).toBe('dispatched')
      expect(database.getDispatchContextById(failed.dispatch.id)).toMatchObject({
        status: 'failed',
        capability_revoked_at: expect.any(String)
      })
      expect(database.getWorkerDispatch(failed.dispatch.id)?.state).toBe('failed')
      expect(database.getDispatchContextById(live.dispatchId)?.status).toBe('dispatched')
      expect(database.getWorkerDispatch(live.dispatchId)?.state).toBe('ready')
    }
  )

  it('atomically preserves an uncertain federated Dispatch while blocking its Task', () => {
    const database = createDatabase()
    const run = database.createRun({
      objective: 'Federated restart uncertainty',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
    })
    const task = database.createTask({
      spec: 'federated restart uncertainty',
      runId: run.id
    })
    const started = database.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {},
      federation: {
        environmentId: 'server-1',
        environmentName: 'worker server',
        peerFingerprint: 'peer-1',
        protocolVersion: 3
      }
    })
    const question = database.createQuestion({
      runId: run.id,
      dispatchId: started.dispatch.id,
      askerHandle: 'term_worker',
      question: 'Should the uncertain worker resume?'
    })

    database.reconcileFederatedWorkerStart({
      dispatchId: started.dispatch.id,
      state: 'start_unknown',
      stage: 'remote_attach',
      lastError: 'worker server restarted'
    })

    expect(database.getWorkerDispatch(started.dispatch.id)).toMatchObject({
      state: 'start_unknown',
      stage: 'remote_attach',
      last_error: 'worker server restarted'
    })
    expect(database.getDispatchContextById(started.dispatch.id)?.status).toBe('pending')
    expect(database.getTask(task.id)?.status).toBe('blocked')
    expect(database.getQuestion(question.message.id)?.status).toBe('pending')
    const settled = {
      worker: database.getWorkerDispatch(started.dispatch.id),
      dispatch: database.getDispatchContextById(started.dispatch.id),
      task: database.getTask(task.id)
    }

    database.reconcileFederatedWorkerStart({
      dispatchId: started.dispatch.id,
      state: 'start_unknown',
      stage: 'remote_attach',
      lastError: 'worker server restarted'
    })

    // A repeated report of the same uncertainty must not re-project any of the three entities.
    expect(database.getWorkerDispatch(started.dispatch.id)).toEqual(settled.worker)
    expect(database.getDispatchContextById(started.dispatch.id)).toEqual(settled.dispatch)
    expect(database.getTask(task.id)).toEqual(settled.task)
    const answered = database.answerQuestion({
      messageId: question.message.id,
      runId: run.id,
      consumerGeneration: run.consumer_generation,
      body: 'yes'
    })
    expect(answered.question.status).toBe('answered')
    expect(answered.message.body).toBe('yes')
  })

  it('rolls back federated start uncertainty when the Task transition cannot commit', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'atomic federated uncertainty'
    })
    const started = database.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {},
      federation: {
        environmentId: 'server-1',
        environmentName: 'worker server',
        peerFingerprint: 'peer-1',
        protocolVersion: 3
      }
    })
    sqliteFor(database).exec(`
      CREATE TRIGGER reject_federated_unknown_task_block
      BEFORE UPDATE ON tasks
      WHEN NEW.status = 'blocked'
      BEGIN SELECT RAISE(ABORT, 'forced federated uncertainty task block failure'); END;
    `)

    expect(() =>
      database.reconcileFederatedWorkerStart({
        dispatchId: started.dispatch.id,
        state: 'start_unknown',
        stage: 'remote_attach',
        lastError: 'worker server restarted'
      })
    ).toThrow('forced federated uncertainty task block failure')
    expect(database.getWorkerDispatch(started.dispatch.id)).toMatchObject({
      state: 'starting',
      stage: 'accepted',
      last_error: null
    })
    expect(database.getDispatchContextById(started.dispatch.id)?.status).toBe('pending')
    expect(database.getTask(task.id)?.status).toBe('dispatched')
  })

  it.each(['stop', 'abandon'] as const)(
    '%s releases the last context-only sibling after a newer worker start fails',
    (operation) => {
      const database = createDatabase()
      const task = database.createTask({
        runId: 'run_legacy_local',
        spec: `${operation} historical sibling`
      })
      const contextOnly = createRootDispatch(database, task.id, `term_${operation}`)
      sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
      const failed = database.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: {}
      })

      database.failWorkerStart(failed.dispatch.id, 'start_failed', 'worker failed to start')
      expect(database.getTask(task.id)?.status).toBe('dispatched')

      const released =
        operation === 'stop'
          ? database.beginWorkerStop(contextOnly.id, 'runtime_test')
          : database.abandonWorkerDispatch(contextOnly.id, 'epoch_test')
      expect(released).toMatchObject({
        disposition: 'context_only',
        alreadySettled: false,
        releasedCurrentTask: true
      })
      expect(database.getTask(task.id)?.status).toBe('blocked')
      expect(database.getDispatchContextById(contextOnly.id)?.status).toBe('failed')
      expect(database.getActiveDispatchForTerminal(`term_${operation}`)).toBeUndefined()
      expect(() =>
        createRootDispatch(
          database,
          database.createTask({
            runId: 'run_legacy_local',
            spec: `${operation} later work`
          }).id,
          `term_${operation}`
        )
      ).not.toThrow()
    }
  )

  it.each(['stop', 'abandon'] as const)(
    '%s records guarded receipts for context-only Dispatch and Task release',
    (operation) => {
      const database = createDatabase()
      const task = database.createTask({
        runId: 'run_legacy_local',
        spec: `${operation} receipt release`
      })
      const contextOnly = createRootDispatch(database, task.id, `term_${operation}`)

      const released =
        operation === 'stop'
          ? database.beginWorkerStop(contextOnly.id, 'runtime_test')
          : database.abandonWorkerDispatch(contextOnly.id, 'epoch_test')

      expect(released).toMatchObject({
        disposition: 'context_only',
        alreadySettled: false,
        releasedCurrentTask: true
      })
      expect(database.getDispatchContextById(contextOnly.id)).toMatchObject({
        status: 'failed',
        last_failure: operation === 'stop' ? 'stopped' : 'abandoned'
      })
      expect(database.getTask(task.id)?.status).toBe('blocked')
    }
  )

  it('rolls back both context-only projections when the Task transition fails', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'context-only atomic receipt'
    })
    const contextOnly = createRootDispatch(database, task.id, 'term_context')
    sqliteFor(database).exec(`
      CREATE TRIGGER reject_context_release_task_block
      BEFORE UPDATE ON tasks
      WHEN NEW.status = 'blocked'
      BEGIN SELECT RAISE(ABORT, 'forced context release task block failure'); END;
    `)

    expect(() => database.beginWorkerStop(contextOnly.id, 'runtime_test')).toThrow(
      'forced context release task block failure'
    )
    expect(database.getTask(task.id)?.status).toBe('dispatched')
    expect(database.getDispatchContextById(contextOnly.id)).toMatchObject({
      status: 'dispatched',
      last_failure: null,
      completed_at: null,
      capability_revoked_at: null
    })
  })

  it.each(['stop', 'abandon'] as const)(
    '%s preserves a live worker sibling and lets it report',
    (operation) => {
      const database = createDatabase()
      const task = database.createTask({
        runId: 'run_legacy_local',
        spec: `${operation} legacy worker split`
      })
      const live = startWorker(database, task.id, `${operation}_live`)
      sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
      const released = startWorker(database, task.id, `${operation}_released`)

      if (operation === 'stop') {
        expect(database.beginWorkerStop(released.dispatchId, 'runtime_test').disposition).toBe(
          'stopping'
        )
        expect(database.settleWorkerStop(released.dispatchId).state).toBe('stopped')
      } else {
        expect(database.abandonWorkerDispatch(released.dispatchId, 'epoch_test').disposition).toBe(
          'abandoned'
        )
      }

      expect(database.getTask(task.id)?.status).toBe('dispatched')
      expect(database.getDispatchContextById(live.dispatchId)?.status).toBe('dispatched')
      expect(
        database.settleWorkerReport({
          taskId: task.id,
          dispatchId: live.dispatchId,
          outcome: 'succeeded',
          result: `${operation} sibling completed`
        })
      ).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: false })
      expect(database.getTask(task.id)?.status).toBe('completed')
      expect(database.getDispatchContextById(live.dispatchId)?.status).toBe('completed')
    }
  )

  it('blocks a Task when an interleaved stop settles its final active Dispatch', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'interleaved legacy worker release'
    })
    const stopping = startWorker(database, task.id, 'interleaved_stopping')
    sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    const abandoned = startWorker(database, task.id, 'interleaved_abandoned')

    expect(database.beginWorkerStop(stopping.dispatchId, 'runtime_test').disposition).toBe(
      'stopping'
    )
    expect(database.abandonWorkerDispatch(abandoned.dispatchId, 'epoch_test').disposition).toBe(
      'abandoned'
    )
    expect(database.getTask(task.id)?.status).toBe('dispatched')

    expect(database.settleWorkerStop(stopping.dispatchId).state).toBe('stopped')
    expect(database.getTask(task.id)?.status).toBe('blocked')
    expect(database.getDispatchContextById(stopping.dispatchId)?.status).toBe('failed')
    expect(database.getDispatchContextById(abandoned.dispatchId)?.status).toBe('failed')
  })

  it('restores a live sibling after stopping an uncertain worker start', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'uncertain legacy worker split'
    })
    const live = startWorker(database, task.id, 'uncertain_live')
    sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    const uncertain = database.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    database.markWorkerStartUnknown(uncertain.dispatch.id, 'agent_readiness', 'outcome unknown')
    expect(database.getTask(task.id)?.status).toBe('blocked')

    expect(database.beginWorkerStop(uncertain.dispatch.id, 'runtime_test').disposition).toBe(
      'stopping'
    )
    expect(database.settleWorkerStop(uncertain.dispatch.id).state).toBe('stopped')
    expect(database.getTask(task.id)?.status).toBe('dispatched')
    expect(
      database.settleWorkerReport({
        taskId: task.id,
        dispatchId: live.dispatchId,
        outcome: 'succeeded',
        result: 'live sibling completed'
      })
    ).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: false })
  })

  it.each(['federated-reconcile', 'missing-terminal'] as const)(
    'restores a live sibling after an uncertain worker start fails through %s',
    (recovery) => {
      const database = createDatabase()
      const task = database.createTask({
        runId: 'run_legacy_local',
        spec: `${recovery} uncertain sibling`
      })
      const live = startWorker(database, task.id, `${recovery}_live`)
      sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
      const uncertain = database.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: {}
      })
      database.markWorkerStartUnknown(uncertain.dispatch.id, 'agent_readiness', 'outcome unknown')

      if (recovery === 'federated-reconcile') {
        database.reconcileFederatedWorkerStart({
          dispatchId: uncertain.dispatch.id,
          state: 'failed',
          stage: 'start_failed',
          lastError: 'worker did not start'
        })
      } else {
        database.reconcileMissingWorkerTerminal(uncertain.dispatch.id, 'worker terminal missing')
      }

      expect(database.getTask(task.id)?.status).toBe('dispatched')
      expect(database.getDispatchContextById(live.dispatchId)?.status).toBe('dispatched')
      expect(
        database.settleWorkerReport({
          taskId: task.id,
          dispatchId: live.dispatchId,
          outcome: 'succeeded',
          result: 'live sibling completed'
        })
      ).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: false })
    }
  )

  it('rejects gate creation while a supervised worker remains active', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'worker gate guard'
    })
    const worker = startWorker(database, task.id, 'gate')

    expect(() => database.createGate({ taskId: task.id, question: 'Proceed?' })).toThrowError(
      expect.objectContaining({
        code: 'task_not_startable',
        data: { taskId: task.id, dispatchId: worker.dispatchId }
      })
    )
    expect(database.listGates({ taskId: task.id })).toHaveLength(0)
    expect(database.getTask(task.id)?.status).toBe('dispatched')
    expect(database.getDispatchContextById(worker.dispatchId)?.status).toBe('dispatched')
    expect(database.getWorkerDispatch(worker.dispatchId)?.state).toBe('ready')
  })

  it('rolls back gate resolution when an active Dispatch blocks readiness', () => {
    const database = createDatabase()
    const task = database.createTask({
      runId: 'run_legacy_local',
      spec: 'corrupt gated task'
    })
    const gate = database.createGate({ taskId: task.id, question: 'Proceed?' })
    sqliteFor(database).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    const dispatch = createRootDispatch(database, task.id, 'term_worker')
    sqliteFor(database).prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(task.id)

    expect(() => database.resolveGate(gate.id, 'yes')).toThrowError(
      expect.objectContaining({ code: 'task_not_startable' })
    )
    expect(database.getGate(gate.id)).toMatchObject({
      status: 'pending',
      resolution: null,
      resolved_at: null
    })
    expect(database.getTask(task.id)?.status).toBe('blocked')
    expect(database.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })
})

function createDatabase(): OrchestrationDb {
  dir = mkdtempSync(join(tmpdir(), 'orca-task-dispatch-lifecycle-'))
  db = new OrchestrationDb(join(dir, 'orchestration.db'))
  return db
}

function claimFiles(database: OrchestrationDb, dispatchId: string, paths = ['src/owned.ts']) {
  return database.claimWorkerFiles({
    runId: 'run_legacy_local',
    workspaceId: 'workspace_claims',
    dispatchId,
    paths,
    flavor: 'case_sensitive'
  })
}

function startWorker(database: OrchestrationDb, taskId: string, name: string): WorkerFixture {
  const started = database.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId,
    startOptions: {}
  })
  const paneSuffix = name.length.toString(16).padStart(12, '0')
  const paneKey = `tab_${name}:aaaaaaaa-aaaa-4aaa-8aaa-${paneSuffix}`
  const processIncarnation = `${name}:1`
  const handle = `term_${name}`
  database.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle,
    paneKey,
    processIncarnation,
    worktreeId: `repo::${name}`,
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  database.markWorkerDispatchReady(started.dispatch.id)
  return { dispatchId: started.dispatch.id, handle, paneKey, processIncarnation }
}

function sqliteFor(database: OrchestrationDb): Database.Database {
  return (database as unknown as { db: Database.Database }).db
}
