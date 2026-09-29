import { describe, expect, it } from 'vitest'
import {
  ClaimPathError,
  claimPathsConflict,
  toClaimPathKey
} from '../../../../../shared/swarm/file-claim-path-key'
import { OrchestrationDb } from '../../db'

const WIN = 'case_insensitive' as const
const POSIX = 'case_sensitive' as const

describe('claim path keys', () => {
  it('treats separators and dot segments as one spelling', () => {
    expect(toClaimPathKey('src\\app\\a.ts', POSIX)).toBe('src/app/a.ts')
    expect(toClaimPathKey('./src/app/a.ts', POSIX)).toBe('src/app/a.ts')
    expect(toClaimPathKey('src/lib/../app/a.ts', POSIX)).toBe('src/app/a.ts')
  })

  it('folds case only on a case-insensitive host', () => {
    expect(toClaimPathKey('SRC/App.ts', WIN)).toBe(toClaimPathKey('src/app.ts', WIN))
    expect(toClaimPathKey('SRC/App.ts', POSIX)).not.toBe(toClaimPathKey('src/app.ts', POSIX))
  })

  it('refuses a path that escapes the workspace instead of clamping it to the root', () => {
    expect(() => toClaimPathKey('../outside.ts', POSIX)).toThrow(ClaimPathError)
    expect(() => toClaimPathKey('src/../../outside.ts', POSIX)).toThrow(/escapes the workspace/)
  })

  it('treats an ancestor and its descendant as conflicting, but not siblings', () => {
    expect(claimPathsConflict('src/parser', 'src/parser/token.ts')).toBe(true)
    expect(claimPathsConflict('src/parser', 'src/parser')).toBe(true)
    expect(claimPathsConflict('src/parser', 'src/parser-ast/index.ts')).toBe(false)
  })
})

/**
 * The fence this table exists for: two workers in one workspace, same task. Before
 * it, nothing recorded who owned a path, so both edited the same file and Orca only
 * learned about it from a `--files-modified` CSV attached after the overwrite.
 */
describe('worker file claims', () => {
  // Claims are keyed by (run, workspace) and own no lifecycle, so a Run row is not
  // needed here - the legacy Run id the depth tests use is enough.
  function newDb(): OrchestrationDb {
    return new OrchestrationDb(':memory:')
  }

  const SCOPE = { runId: 'run_legacy_local', workspaceId: 'wt_shared' }

  it('grants distinct paths to parallel workers in one workspace', () => {
    const db = newDb()
    const a = db.claimWorkerFiles({
      ...SCOPE,
      dispatchId: 'dispatch_a',
      paths: ['src/app/a.ts', 'src/app/a.test.ts'],
      flavor: POSIX
    })
    const b = db.claimWorkerFiles({
      ...SCOPE,
      dispatchId: 'dispatch_b',
      paths: ['src/app/b.ts'],
      flavor: POSIX
    })

    expect(a.refused).toEqual([])
    expect(b.refused).toEqual([])
    expect(db.listWorkerFileClaims(SCOPE)).toHaveLength(3)
    db.close()
  })

  it('refuses a path another worker already holds, naming the holder', () => {
    const db = newDb()
    db.claimWorkerFiles({
      ...SCOPE,
      dispatchId: 'dispatch_a',
      paths: ['src/app/shared.ts'],
      flavor: POSIX
    })

    const clash = db.claimWorkerFiles({
      ...SCOPE,
      dispatchId: 'dispatch_b',
      paths: ['src/app/shared.ts'],
      flavor: POSIX
    })

    expect(clash.granted).toEqual([])
    expect(clash.refused).toEqual([
      {
        claimKey: 'src/app/shared.ts',
        displayPath: 'src/app/shared.ts',
        heldByDispatchId: 'dispatch_a'
      }
    ])
    db.close()
  })

  it('refuses a file whose directory another worker claimed', () => {
    const db = newDb()
    db.claimWorkerFiles({
      ...SCOPE,
      dispatchId: 'dispatch_a',
      paths: ['src/parser'],
      flavor: POSIX
    })

    const nested = db.claimWorkerFiles({
      ...SCOPE,
      dispatchId: 'dispatch_b',
      paths: ['src/parser/token.ts'],
      flavor: POSIX
    })

    expect(nested.refused[0].heldByDispatchId).toBe('dispatch_a')
    db.close()
  })

  it('does not let a worker double-claim its own path', () => {
    const db = newDb()
    const first = db.claimWorkerFiles({
      ...SCOPE,
      dispatchId: 'dispatch_a',
      paths: ['src/app/a.ts'],
      flavor: POSIX
    })
    const again = db.claimWorkerFiles({
      ...SCOPE,
      dispatchId: 'dispatch_a',
      paths: ['src/app/a.ts'],
      flavor: POSIX
    })

    expect(first.granted).toHaveLength(1)
    expect(again.refused).toEqual([])
    expect(again.granted).toHaveLength(1)
    db.close()
  })

  it('catches the same file spelled differently', () => {
    const db = newDb()
    db.claimWorkerFiles({
      ...SCOPE,
      dispatchId: 'dispatch_a',
      paths: ['src/app/a.ts'],
      flavor: WIN
    })

    const other = db.claimWorkerFiles({
      ...SCOPE,
      dispatchId: 'dispatch_b',
      paths: ['SRC\\App\\A.ts'],
      flavor: WIN
    })

    expect(other.refused).toHaveLength(1)
    db.close()
  })

  it('does not let two workspaces collide, and does not leak across runs', () => {
    const db = newDb()
    db.claimWorkerFiles({
      ...SCOPE,
      dispatchId: 'dispatch_a',
      paths: ['src/app/a.ts'],
      flavor: POSIX
    })

    const otherWorkspace = db.claimWorkerFiles({
      runId: SCOPE.runId,
      workspaceId: 'wt_other',
      dispatchId: 'dispatch_b',
      paths: ['src/app/a.ts'],
      flavor: POSIX
    })
    const otherRun = db.claimWorkerFiles({
      runId: 'run_second',
      workspaceId: SCOPE.workspaceId,
      dispatchId: 'dispatch_c',
      paths: ['src/app/a.ts'],
      flavor: POSIX
    })

    expect(otherWorkspace.refused).toEqual([])
    expect(otherRun.refused).toEqual([])
    db.close()
  })

  it('frees a settled worker path for the next worker', () => {
    const db = newDb()
    db.claimWorkerFiles({
      ...SCOPE,
      dispatchId: 'dispatch_a',
      paths: ['src/app/a.ts'],
      flavor: POSIX
    })

    expect(db.releaseFileClaimsForDispatch('dispatch_a')).toBe(1)

    const next = db.claimWorkerFiles({
      ...SCOPE,
      dispatchId: 'dispatch_b',
      paths: ['src/app/a.ts'],
      flavor: POSIX
    })
    expect(next.refused).toEqual([])
    db.close()
  })

  it('reports conflicts read-only, so a worker can ask before it edits', () => {
    const db = newDb()
    db.claimWorkerFiles({
      ...SCOPE,
      dispatchId: 'dispatch_a',
      paths: ['src/parser'],
      flavor: POSIX
    })

    const conflicts = db.findConflictingFileClaims({
      ...SCOPE,
      dispatchId: 'dispatch_b',
      paths: ['src/parser/token.ts', 'src/app/ok.ts'],
      flavor: POSIX
    })

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].displayPath).toBe('src/parser/token.ts')
    expect(db.listFileClaimsForDispatch('dispatch_a')).toHaveLength(1)
    db.close()
  })

  it('keeps the claims its siblings earned when one path in the list is bad', () => {
    const db = newDb()
    const result = db.claimWorkerFiles({
      ...SCOPE,
      dispatchId: 'dispatch_a',
      paths: ['src/app/ok.ts', '../escape.ts'],
      flavor: POSIX
    })

    expect(result.granted.map((row) => row.claim_key)).toEqual(['src/app/ok.ts'])
    expect(result.refused).toHaveLength(1)
    db.close()
  })

  it('throws a refusal that names the holder so the worker can negotiate', () => {
    const db = newDb()
    db.claimWorkerFiles({
      ...SCOPE,
      dispatchId: 'dispatch_a',
      paths: ['src/app/shared.ts'],
      flavor: POSIX
    })
    const clash = db.claimWorkerFiles({
      ...SCOPE,
      dispatchId: 'dispatch_b',
      paths: ['src/app/shared.ts'],
      flavor: POSIX
    })

    expect(() => db.throwOnRefusedFileClaims(clash.refused)).toThrow(
      /already claimed by dispatch dispatch_a/
    )
    expect(() => db.throwOnRefusedFileClaims([])).not.toThrow()
    db.close()
  })
})
