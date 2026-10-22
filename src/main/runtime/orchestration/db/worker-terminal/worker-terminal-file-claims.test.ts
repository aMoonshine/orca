import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db'
import { AGENT_PROMPT_STALLED_ERROR } from '../../../agent-prompt-submission-verification'

let database: OrchestrationDb | undefined

afterEach(() => {
  database?.close()
  database = undefined
})

function createDatabase(): OrchestrationDb {
  database = new OrchestrationDb(':memory:')
  return database
}

function claimFiles(db: OrchestrationDb, dispatchId: string, paths = ['src/owned.ts']) {
  return db.claimWorkerFiles({
    runId: 'run_legacy_local',
    workspaceId: 'folder',
    dispatchId,
    paths,
    flavor: 'case_sensitive'
  })
}

describe('stalled worker terminal claim cleanup', () => {
  it.each(['dead-release', 'release', 'missing-terminal'] as const)(
    'releases stalled failed-start claims only after positive cleanup through %s',
    (operation) => {
      const database = createDatabase()
      const started = database.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: 10,
        taskRunId: 'run_legacy_local',
        taskSpec: 'stalled terminal cleanup',
        startOptions: {}
      })
      database.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_stalled',
        paneKey: 'tab_stalled:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        processIncarnation: 'stalled:1',
        worktreeId: 'folder',
        effects: [],
        setupState: 'not_applicable',
        terminalOwnership: 'created'
      })
      const claims = claimFiles(database, started.dispatch.id).granted
      const peer = claimFiles(database, 'peer', ['src/peer.ts']).granted
      database.failWorkerStart(started.dispatch.id, 'prompt_delivery', AGENT_PROMPT_STALLED_ERROR)
      const resource = database.getWorkerTerminalResourceByOwner(started.dispatch.id)
      if (!resource) {
        throw new Error('expected owned stalled terminal')
      }
      expect(database.listFileClaimsForDispatch(started.dispatch.id)).toEqual(claims)
      expect(
        database.settleDeadWorkerTerminalRelease({
          requestingDispatchId: started.dispatch.id,
          resourceId: resource.id,
          processIncarnation: 'different:1'
        }).disposition
      ).toBe('retained')
      expect(database.listFileClaimsForDispatch(started.dispatch.id)).toEqual(claims)

      if (operation === 'missing-terminal') {
        database.reconcileMissingWorkerTerminal(started.dispatch.id, 'positive terminal exit')
      } else if (operation === 'dead-release') {
        expect(
          database.settleDeadWorkerTerminalRelease({
            requestingDispatchId: started.dispatch.id,
            resourceId: resource.id,
            processIncarnation: 'stalled:1'
          }).disposition
        ).toBe('released')
      } else {
        database.requestWorkerTerminalRelease(started.dispatch.id)
        database.markWorkerTerminalReleaseUnknown(resource.id, 'close response lost')
        expect(database.listFileClaimsForDispatch(started.dispatch.id)).toEqual(claims)
        database.settleWorkerTerminalRelease(resource.id)
      }
      expect(database.listFileClaimsForDispatch(started.dispatch.id)).toEqual([])
      expect(database.listFileClaimsForDispatch('peer')).toEqual(peer)
    }
  )

  it('keeps stalled claims through user takeover and refuses terminal cleanup without ownership', () => {
    const database = createDatabase()
    const started = database.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 10,
      taskRunId: 'run_legacy_local',
      taskSpec: 'stalled takeover',
      startOptions: {}
    })
    const paneKey = 'tab_stalled:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    database.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_stalled',
      paneKey,
      processIncarnation: 'stalled:1',
      worktreeId: 'folder',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    const claims = claimFiles(database, started.dispatch.id).granted
    database.failWorkerStart(started.dispatch.id, 'prompt_delivery', AGENT_PROMPT_STALLED_ERROR)
    const resource = database.getWorkerTerminalResourceByOwner(started.dispatch.id)
    if (!resource) {
      throw new Error('expected stalled terminal')
    }
    database.requestWorkerTerminalRelease(started.dispatch.id)
    database.markWorkerTerminalUserOwned(paneKey)
    expect(
      database.settleDeadWorkerTerminalRelease({
        requestingDispatchId: started.dispatch.id,
        resourceId: resource.id,
        processIncarnation: 'stalled:1'
      }).disposition
    ).toBe('retained')
    expect(database.settleWorkerTerminalRelease(resource.id)).toMatchObject({
      ownership_state: 'user_owned',
      release_state: 'retained'
    })
    expect(database.listFileClaimsForDispatch(started.dispatch.id)).toEqual(claims)
  })

  it.each(['dead-release', 'release', 'missing-terminal'] as const)(
    'rolls back %s cleanup when claim deletion fails',
    (operation) => {
      const database = createDatabase()
      const started = database.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: 10,
        taskRunId: 'run_legacy_local',
        taskSpec: 'atomic stalled cleanup',
        startOptions: {}
      })
      database.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_stalled',
        paneKey: 'tab_stalled:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        processIncarnation: 'stalled:1',
        worktreeId: 'folder',
        effects: [],
        setupState: 'not_applicable',
        terminalOwnership: 'created'
      })
      const claims = claimFiles(database, started.dispatch.id).granted
      database.failWorkerStart(started.dispatch.id, 'prompt_delivery', AGENT_PROMPT_STALLED_ERROR)
      const resource = database.getWorkerTerminalResourceByOwner(started.dispatch.id)
      if (!resource) {
        throw new Error('expected stalled terminal')
      }
      if (operation === 'release') {
        database.requestWorkerTerminalRelease(started.dispatch.id)
      }
      const before = database.getWorkerTerminalResource(resource.id)
      database.db.exec(
        `CREATE TRIGGER reject_claim_release BEFORE DELETE ON worker_file_claims BEGIN SELECT RAISE(ABORT, 'claim cleanup failed'); END;`
      )
      expect(() => {
        if (operation === 'dead-release') {
          database.settleDeadWorkerTerminalRelease({
            requestingDispatchId: started.dispatch.id,
            resourceId: resource.id,
            processIncarnation: 'stalled:1'
          })
        } else if (operation === 'release') {
          database.settleWorkerTerminalRelease(resource.id)
        } else {
          database.reconcileMissingWorkerTerminal(started.dispatch.id, 'positive exit')
        }
      }).toThrow('claim cleanup failed')
      expect(database.getWorkerTerminalResource(resource.id)).toEqual(before)
      expect(database.listFileClaimsForDispatch(started.dispatch.id)).toEqual(claims)
      expect(database.db.isTransaction).toBe(false)
    }
  )
})
