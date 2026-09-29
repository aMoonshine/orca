import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { buildDispatchPreamble } from '../../../../orchestration/preamble'
import {
  claimPathFlavorForWorkspace,
  claimWorkerStartFiles,
  parseClaimPaths
} from './worker-start-file-claims'

/**
 * The end-to-end contract a swarm depends on: two workers, one directory, one task.
 * A worker that names a file another live worker owns must be refused before it can
 * create a terminal, and the refusal must name the holder so a coordinator can
 * re-split rather than just retry.
 */
describe('worker-start file claims', () => {
  function newDb(): OrchestrationDb {
    return new OrchestrationDb(':memory:')
  }

  const SCOPE = {
    runId: 'run_legacy_local',
    workspaceId: 'wt_shared',
    workspacePath: 'C:\\repo'
  }

  describe('parseClaimPaths', () => {
    it('reads a comma-separated list and drops blanks', () => {
      expect(parseClaimPaths('src/a.ts, src/b.ts ,')).toEqual(['src/a.ts', 'src/b.ts'])
      expect(parseClaimPaths(undefined)).toEqual([])
      expect(parseClaimPaths('')).toEqual([])
    })
  })

  describe('claimPathFlavorForWorkspace', () => {
    it('follows the workspace filesystem, not the running host', () => {
      expect(claimPathFlavorForWorkspace('C:\\repo')).toBe('case_insensitive')
      // A POSIX root reached over SSH is case-sensitive even from a Windows host.
      expect(claimPathFlavorForWorkspace('/home/me/repo')).toBe('case_sensitive')
    })
  })

  it('claims paths for a worker and reports its siblings', () => {
    const db = newDb()
    claimWorkerStartFiles({
      db,
      ...SCOPE,
      dispatchId: 'dispatch_a',
      claims: 'src/a.ts,src/b.ts'
    })

    const second = claimWorkerStartFiles({
      db,
      ...SCOPE,
      dispatchId: 'dispatch_b',
      claims: 'src/c.ts'
    })

    expect(second.claims.map((row) => row.claim_key)).toEqual(['src/c.ts'])
    expect(second.ownedByOthers.map((row) => row.claim_key)).toEqual(['src/a.ts', 'src/b.ts'])
    db.close()
  })

  it('refuses a worker that overlaps a live peer, naming the holder', () => {
    const db = newDb()
    claimWorkerStartFiles({ db, ...SCOPE, dispatchId: 'dispatch_a', claims: 'src/a.ts' })

    // Captured rather than thrown so the assertion covers the code and the named
    // holder, not just that something failed.
    let caught: OrchestrationError | undefined
    try {
      claimWorkerStartFiles({ db, ...SCOPE, dispatchId: 'dispatch_b', claims: 'src/a.ts' })
    } catch (error) {
      if (error instanceof OrchestrationError) {
        caught = error
      }
    }

    expect(caught?.code).toBe('file_claim_conflict')
    expect(caught?.message).toContain('dispatch_a')
    db.close()
  })

  it('does nothing when a worker names no paths', () => {
    const db = newDb()

    const outcome = claimWorkerStartFiles({
      db,
      ...SCOPE,
      dispatchId: 'dispatch_a',
      claims: undefined
    })

    expect(outcome).toEqual({ claims: [], ownedByOthers: [] })
    expect(db.listWorkerFileClaims({ runId: SCOPE.runId, workspaceId: SCOPE.workspaceId })).toEqual(
      []
    )
    db.close()
  })

  it('refuses a claim during a read-only phase, so the mode is enforced not just described', () => {
    const db = newDb()
    db.createRun({
      objective: 'Parallel refactor',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf',
      mode: 'swarm'
    })
    const run = db.getCurrentRunForCoordinator({
      terminalHandle: 'term_coord',
      paneKey: 'tab_coord:leaf',
      orcaSessionId: null
    })
    if (!run) {
      throw new Error('expected a bound run')
    }

    // Swarm starts in coordination, where the spec forbids editing anything.
    let caught: OrchestrationError | undefined
    try {
      claimWorkerStartFiles({
        db,
        runId: run.id,
        workspaceId: SCOPE.workspaceId,
        workspacePath: SCOPE.workspacePath,
        dispatchId: 'dispatch_a',
        claims: 'src/a.ts'
      })
    } catch (error) {
      if (error instanceof OrchestrationError) {
        caught = error
      }
    }
    expect(caught?.code).toBe('file_claim_phase_read_only')
    // No row is left behind for a worker that was refused.
    expect(db.listFileClaimsForDispatch('dispatch_a')).toEqual([])

    db.advanceRunPhase({ runId: run.id })
    const granted = claimWorkerStartFiles({
      db,
      runId: run.id,
      workspaceId: SCOPE.workspaceId,
      workspacePath: SCOPE.workspacePath,
      dispatchId: 'dispatch_a',
      claims: 'src/a.ts'
    })
    expect(granted.claims).toHaveLength(1)
    db.close()
  })
})

describe('dispatch preamble file ownership', () => {
  function preambleWith(fileClaims: Parameters<typeof buildDispatchPreamble>[0]['fileClaims']) {
    return buildDispatchPreamble({
      taskId: 'task_1',
      dispatchId: 'dispatch_1',
      taskSpec: 'Refactor the parser',
      coordinatorHandle: 'term_coord',
      workerHandle: 'term_worker',
      fileClaims
    })
  }

  it('omits the section entirely for a single-agent workspace', () => {
    const result = preambleWith({ owned: [], ownedByOthers: [] })
    expect(result).not.toContain('=== FILE OWNERSHIP ===')
    expect(result).not.toContain('=== TASK ===\nundefined')
  })

  it('names the paths the worker owns', () => {
    const result = preambleWith({
      owned: [{ display_path: 'src/parser/token.ts' }],
      ownedByOthers: []
    })

    expect(result).toContain('=== FILE OWNERSHIP ===')
    expect(result).toContain('src/parser/token.ts')
    expect(result).toContain('released when you send `worker_done`')
  })

  it('names the peer holding a path so the worker treats it as read-only', () => {
    const result = preambleWith({
      owned: [{ display_path: 'src/a.ts' }],
      ownedByOthers: [
        { display_path: 'src/b.ts', dispatch_id: 'dispatch_b' },
        { display_path: 'src/c.ts', dispatch_id: 'dispatch_c' }
      ]
    })

    expect(result).toContain('src/b.ts (dispatch dispatch_b)')
    expect(result).toContain('src/c.ts (dispatch dispatch_c)')
    expect(result).toContain('treat as read-only')
    // The section lands before the task, so a worker reads its boundary before the work.
    expect(result.indexOf('=== FILE OWNERSHIP ===')).toBeLessThan(result.indexOf('=== TASK ==='))
  })
})

describe('dispatch preamble work mode', () => {
  it('omits the section for a solo worker, who has no protocol to follow', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_1',
      dispatchId: 'dispatch_1',
      taskSpec: 'Fix the bug',
      coordinatorHandle: 'term_coord',
      workerHandle: 'term_worker'
    })
    expect(result).not.toContain('=== WORK MODE')
  })

  it('tells a swarm peer which phase it is in and that editing is refused there', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_1',
      dispatchId: 'dispatch_1',
      taskSpec: 'Refactor the parser',
      coordinatorHandle: 'term_coord',
      workerHandle: 'term_worker',
      workMode: {
        modeLabel: 'Swarm',
        phaseLabel: 'Coordination',
        phaseInstruction: 'Do not edit any file. Read the repository.',
        round: 1,
        isFinalPhase: false
      }
    })

    expect(result).toContain('=== WORK MODE: Swarm / Coordination ===')
    expect(result).toContain('Do not edit any file')
    expect(result).toContain('a claim there is refused by the runtime')
    expect(result).toContain('The coordinator advances the phase')
  })

  it('marks the last phase so a worker stops instead of starting new work', () => {
    const result = buildDispatchPreamble({
      taskId: 'task_1',
      dispatchId: 'dispatch_1',
      taskSpec: 'Refactor the parser',
      coordinatorHandle: 'term_coord',
      workerHandle: 'term_worker',
      workMode: {
        modeLabel: 'Swarm',
        phaseLabel: 'Catch-up',
        phaseInstruction: 'Read what arrived and adjust.',
        round: 2,
        isFinalPhase: true
      }
    })

    expect(result).toContain('This is the last phase of the protocol')
    expect(result).toContain('round 2')
  })
})
