import '../../../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { buildDispatchPreamble } from '../../../../orchestration/preamble'
import {
  claimPathFlavorForWorkspace,
  bindWorkerStartFiles,
  claimWorkerStartFiles,
  parseClaimPaths,
  reserveWorkerStartFiles
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

  it('requires a real workspace identity and path when recording final claims', () => {
    const db = newDb()
    for (const workspace of [
      { workspaceId: '', workspacePath: 'C:\\repo' },
      { workspaceId: 'wt', workspacePath: '' }
    ]) {
      expect(() =>
        claimWorkerStartFiles({ db, ...SCOPE, ...workspace, dispatchId: 'a', claims: 'src/a.ts' })
      ).toThrow()
    }
    expect(db.listFileClaimsForDispatch('a')).toEqual([])
    db.close()
  })

  it('preserves an uncertain starting worker reservation instead of rebinding it', () => {
    const db = newDb()
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 10,
      taskRunId: SCOPE.runId,
      taskSpec: 'uncertain placement',
      startOptions: {}
    })
    const reservation = reserveWorkerStartFiles({
      db,
      runId: SCOPE.runId,
      dispatchId: started.dispatch.id,
      claims: 'src/app.ts'
    })
    db.markWorkerStartUnknown(started.dispatch.id, 'worktree_create', 'connection lost')
    expect(() =>
      bindWorkerStartFiles({ db, ...SCOPE, dispatchId: started.dispatch.id, claims: 'src/app.ts' })
    ).toThrow(/starting worker reservation/)
    expect(db.listFileClaimsForDispatch(started.dispatch.id)).toEqual(reservation.claims)
    db.close()
  })

  it('reserves independent new workspaces and binds Windows case rules before a prompt', () => {
    const db = newDb()
    const reservation = reserveWorkerStartFiles({
      db,
      runId: SCOPE.runId,
      dispatchId: 'a',
      claims: 'SRC/App.ts'
    })
    const peer = reserveWorkerStartFiles({
      db,
      runId: SCOPE.runId,
      dispatchId: 'b',
      claims: 'SRC/App.ts'
    })
    expect(reservation.claims[0].workspace_id).not.toBe('')
    expect(peer.claims[0].workspace_id).not.toBe(reservation.claims[0].workspace_id)

    const bound = bindWorkerStartFiles({ db, ...SCOPE, dispatchId: 'a', claims: 'SRC/App.ts' })
    expect(bound.claims).toMatchObject([
      { workspace_id: SCOPE.workspaceId, claim_key: 'src/app.ts' }
    ])
    expect(db.listFileClaimsForDispatch('a')).toEqual(bound.claims)
    expect(() =>
      claimWorkerStartFiles({ db, ...SCOPE, dispatchId: 'c', claims: 'src/app.ts' })
    ).toThrow(/already claimed/)
    expect(() =>
      bindWorkerStartFiles({
        db,
        ...SCOPE,
        workspaceId: 'another-worktree',
        dispatchId: 'b',
        claims: 'src/app.ts'
      })
    ).not.toThrow()
    db.close()
  })

  it('binds POSIX claims with case sensitivity and restores reservations after a refused bind', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const db = newDb()
    reserveWorkerStartFiles({ db, runId: SCOPE.runId, dispatchId: 'a', claims: 'SRC/App.ts' })
    bindWorkerStartFiles({
      db,
      ...SCOPE,
      workspacePath: '/repo',
      dispatchId: 'a',
      claims: 'SRC/App.ts'
    })
    claimWorkerStartFiles({
      db,
      ...SCOPE,
      workspacePath: '/repo',
      dispatchId: 'b',
      claims: 'src/app.ts'
    })
    const reserved = reserveWorkerStartFiles({
      db,
      runId: SCOPE.runId,
      dispatchId: 'c',
      claims: 'SRC/App.ts,src/new.ts'
    })

    expect(() =>
      bindWorkerStartFiles({
        db,
        ...SCOPE,
        workspacePath: '/repo',
        dispatchId: 'c',
        claims: 'SRC/App.ts,src/new.ts'
      })
    ).toThrow(/already claimed/)
    expect(db.listFileClaimsForDispatch('c')).toEqual(reserved.claims)
    expect(db.listWorkerFileClaims(SCOPE)).toHaveLength(2)
    db.close()
    vi.restoreAllMocks()
  })

  describe('parseClaimPaths', () => {
    it('reads a comma-separated list and drops blanks', () => {
      expect(parseClaimPaths('src/a.ts, src/b.ts ,')).toEqual(['src/a.ts', 'src/b.ts'])
      expect(parseClaimPaths(undefined)).toEqual([])
      expect(parseClaimPaths('')).toEqual([])
    })
  })

  describe('claimPathFlavorForWorkspace', () => {
    it('uses conservative case folding for macOS and unknown POSIX roots', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
      expect(claimPathFlavorForWorkspace('/Users/me/repo')).toBe('case_insensitive')
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      expect(claimPathFlavorForWorkspace('C:\\repo')).toBe('case_insensitive')
      expect(claimPathFlavorForWorkspace('/home/me/repo')).toBe('case_insensitive')
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
      expect(claimPathFlavorForWorkspace('/home/me/repo')).toBe('case_sensitive')
      expect(claimPathFlavorForWorkspace('\\\\wsl.localhost\\Ubuntu\\home\\me')).toBe(
        'case_sensitive'
      )
      vi.restoreAllMocks()
    })

    it('refuses macOS case aliases held by another worker', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
      const db = newDb()
      claimWorkerStartFiles({
        db,
        ...SCOPE,
        workspacePath: '/Users/me/repo',
        dispatchId: 'mac_a',
        claims: 'SRC/App.ts'
      })
      expect(() =>
        claimWorkerStartFiles({
          db,
          ...SCOPE,
          workspacePath: '/Users/me/repo',
          dispatchId: 'mac_b',
          claims: 'src/app.ts'
        })
      ).toThrow(/already claimed/)
      db.close()
      vi.restoreAllMocks()
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

describe('worker-start placement claim ordering', () => {
  const harness = createOrchestrationRpcHarness()
  afterEach(() => harness.cleanup())

  function setup() {
    const state = harness.setup()
    const { runtime, db } = state
    const worktree = (id: string) => {
      const git = {
        path: 'C:\\repo\\created',
        head: 'abc',
        branch: 'main',
        isBare: false,
        isMainWorktree: false
      }
      return {
        ...git,
        id,
        repoId: 'repo',
        displayName: id,
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        linkedItems: [],
        parentWorktreeId: null,
        childWorktreeIds: [],
        lineage: null,
        git
      }
    }
    const workerTerminal = {
      handle: 'term_worker',
      ptyId: 'pty_worker',
      worktreeId: 'created',
      worktreePath: 'C:\\repo\\created',
      branch: 'main',
      tabId: 'tab_worker',
      leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Codex',
      connected: true,
      writable: true,
      lastOutputAt: null,
      preview: ''
    }
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord'
        ? harness.coordinatorPaneKey
        : 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      ...workerTerminal,
      handle: 'term_coord',
      worktreeId: 'parent',
      paneRuntimeId: 1,
      rendererGraphEpoch: 1
    })
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue(worktree('parent'))
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockImplementation(async (selector) =>
      worktree(selector.replace(/^id:/, ''))
    )
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      id: 'repo',
      kind: 'git',
      path: 'C:\\repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 0
    })
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [workerTerminal],
      totalCount: 1,
      truncated: false
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    const prompt = vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockImplementation(async () => {
      const worker = db.getActiveDispatchForTerminal('term_worker')
      if (!worker) {
        throw new Error('Expected authority before prompt delivery')
      }
      const claims = db.listFileClaimsForDispatch(worker.id)
      expect(claims).toMatchObject([{ workspace_id: 'created', claim_key: 'src/app.ts' }])
      return { handle: 'term_worker', accepted: true, bytesWritten: 1 }
    })
    const create = vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async () => {
      if (!state.activeRunId) {
        throw new Error('Expected active Run')
      }
      expect(db.listWorkerFileClaims({ runId: state.activeRunId, workspaceId: '' })).toEqual([])
      return {
        worktree: worktree('created'),
        startupTerminal: { spawned: true, handle: 'term_worker' },
        setupReceipt: {
          requested: 'skip',
          hookFound: false,
          startupPolicy: 'start-immediately',
          state: 'skipped'
        }
      }
    })
    const terminal = vi.spyOn(runtime, 'createTerminal')
    return { ...state, prompt, create, terminal }
  }

  it.each(['new-child', 'new-top-level'])(
    'binds %s claims to the actual workspace before task delivery',
    async (worktree) => {
      const { db, ctx, create, prompt } = setup()
      const task = db.createTask({ spec: 'new workspace claims' })
      const result = await harness.call(
        'orchestration.workerStart',
        {
          task: task.id,
          from: 'term_coord',
          agent: 'codex',
          worktree,
          name: 'created',
          claims: 'SRC/App.ts',
          setup: 'skip'
        },
        ctx
      )
      expect(result).toMatchObject({ state: 'ready' })
      expect(create).toHaveBeenCalledOnce()
      expect(prompt).toHaveBeenCalledOnce()
      expect(db.listWorkerFileClaims({ runId: task.run_id, workspaceId: 'created' })).toHaveLength(
        1
      )
    }
  )

  it('refuses existing workspace conflicts before terminal creation or task delivery', async () => {
    const { db, ctx, create, prompt, terminal } = setup()
    const task = db.createTask({ spec: 'existing workspace claims' })
    db.claimWorkerFiles({
      runId: task.run_id,
      workspaceId: 'parent',
      dispatchId: 'peer',
      paths: ['src/app.ts'],
      flavor: 'case_insensitive'
    })
    const result = await harness.call(
      'orchestration.workerStart',
      { task: task.id, from: 'term_coord', agent: 'codex', claims: 'SRC/App.ts' },
      ctx
    )
    expect(result).toMatchObject({ state: 'failed', failedStage: 'file_claim' })
    expect(create).not.toHaveBeenCalled()
    expect(terminal).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    expect(db.listFileClaimsForDispatch('peer')).toHaveLength(1)
  })

  it('refuses new workspace claims during a read-only phase before placement', async () => {
    const { db, ctx, create, prompt, terminal } = setup()
    const task = db.createTask({ spec: 'read-only admission' })
    db.setRunWorkMode({ runId: task.run_id, mode: 'swarm' })
    const result = await harness.call(
      'orchestration.workerStart',
      {
        task: task.id,
        from: 'term_coord',
        agent: 'codex',
        worktree: 'new-child',
        name: 'created',
        claims: 'src/a.ts'
      },
      ctx
    )
    expect(result).toMatchObject({ state: 'failed', failedStage: 'file_claim' })
    expect(create).not.toHaveBeenCalled()
    expect(terminal).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
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
