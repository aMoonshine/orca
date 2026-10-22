import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { startFederatedWorker } from './federated-worker-start'

describe('federated worker claim admission', () => {
  const databases: OrchestrationDb[] = []
  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
  })

  function setup(mode: 'solo' | 'swarm' | 'fusion' | 'orchestrator', claims?: string) {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const runtime = new OrcaRuntimeService()
    const run = db.createRun({
      objective: 'remote claim admission',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf',
      mode
    })
    const task = db.createTask({ runId: run.id, spec: 'remote writer' })
    const resolve = vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockImplementation(() => {
      throw new Error('remote preflight reached')
    })
    const remote = vi.spyOn(runtime, 'callOrchestrationWorkerServer')
    const start = () =>
      startFederatedWorker({
        db,
        runtime,
        runId: run.id,
        task,
        params: {
          task: task.id,
          from: 'term_coord',
          on: 'remote',
          worktree: 'id:remote_workspace',
          agent: 'codex',
          claims
        },
        orchestrationMutation: {
          callerFingerprint: 'caller',
          requestId: 'start',
          method: 'orchestration.workerStart',
          payloadHash: 'payload'
        }
      })
    return { db, task, resolve, remote, start }
  }

  it.each([
    ['solo', 'src/a.ts'],
    ['swarm', undefined],
    ['fusion', undefined],
    ['orchestrator', undefined]
  ] as const)(
    'refuses unsupported %s claims or mode before remote effects',
    async (mode, claims) => {
      const { db, task, resolve, remote, start } = setup(mode, claims)
      await expect(start()).rejects.toMatchObject({
        code: 'capability_unsupported',
        message: expect.stringContaining('file claims and non-solo work modes'),
        data: expect.objectContaining({ effectsApplied: false })
      })
      expect(resolve).not.toHaveBeenCalled()
      expect(remote).not.toHaveBeenCalled()
      expect(db.getDispatchContext(task.id)).toBeUndefined()
      expect(db.getTask(task.id)?.status).toBe('ready')
    }
  )

  it.each([undefined, '', ' , '])(
    'preserves solo starts without claim paths: %j',
    async (claims) => {
      const { start, resolve } = setup('solo', claims)
      await expect(start()).rejects.toThrow('remote preflight reached')
      expect(resolve).toHaveBeenCalledOnce()
    }
  )
})
