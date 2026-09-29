import {
  ClaimPathError,
  claimPathsConflict,
  toClaimPathKey,
  type ClaimPathFlavor
} from '../../../../../shared/swarm/file-claim-path-key'
import type { SqliteRow } from '../../../../sqlite/sqlite-statement'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

export type WorkerFileClaimRow = {
  run_id: string
  workspace_id: string
  claim_key: string
  display_path: string
  dispatch_id: string
  claimed_at: string
}

/**
 * Why the row type is written out here rather than derived: every query below is
 * `SELECT *` against a table whose schema is declared in create-core-tables-sql, and
 * the driver's row type is an untyped record by design. These two narrowers are the
 * single place that assumption lives, rather than a cast at every call site.
 */
function toClaimRows(rows: SqliteRow[]): WorkerFileClaimRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over worker_file_claims returns the columns this file's schema declares, and WorkerFileClaimRow names each of them.
  return rows as WorkerFileClaimRow[]
}

function toClaimRow(row: SqliteRow | undefined): WorkerFileClaimRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same SELECT * invariant as toClaimRows, narrowed for the single-row lookup.
  return row as WorkerFileClaimRow | undefined
}

/** A path this worker asked for and did not get, with the name of the worker holding it. */
export type RefusedFileClaim = {
  claimKey: string
  displayPath: string
  /** The dispatch already holding the path, or null when no live claim conflicts. */
  heldByDispatchId: string | null
}

export type ClaimWorkerFilesResult = {
  granted: WorkerFileClaimRow[]
  refused: RefusedFileClaim[]
}

function findConflicts(
  this: OrchestrationDb,
  runId: string,
  workspaceId: string,
  claimKey: string
): WorkerFileClaimRow[] {
  // Why prefix rows and filter in JS: overlap is a path-boundary question
  // (`key` or `key/`), which SQLite cannot express as a single indexed predicate
  // without a LIKE per candidate row. Anchoring on `key || '/'` keeps the scan
  // bounded to the one subtree instead of every claim in the workspace.
  const rows = this.db
    .prepare(
      `SELECT * FROM worker_file_claims
       WHERE run_id = ? AND workspace_id = ?
         AND (claim_key = ? OR claim_key LIKE ? ESCAPE '\\'
              OR ? LIKE claim_key || '/%')
       ORDER BY claim_key`
    )
    .all(runId, workspaceId, claimKey, `${escapeLikePrefix(claimKey)}/%`, claimKey)
  return toClaimRows(rows).filter((row) => claimPathsConflict(row.claim_key, claimKey))
}

/** Why escape: a claim key may contain `_` or `%`, which LIKE would otherwise read as a wildcard. */
function escapeLikePrefix(key: string): string {
  return key.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function readClaimRow(
  this: OrchestrationDb,
  runId: string,
  workspaceId: string,
  key: string
): WorkerFileClaimRow | undefined {
  return toClaimRow(
    this.db
      .prepare(
        'SELECT * FROM worker_file_claims WHERE run_id = ? AND workspace_id = ? AND claim_key = ?'
      )
      .get(runId, workspaceId, key)
  )
}

/**
 * Record which paths a worker owns, refusing any path another live worker holds.
 *
 * Why all-or-nothing per path rather than per call: a worker handed three paths
 * and granted one is in a state no caller can act on - it does not know which edits
 * are safe, and the receipt it reports to its coordinator is wrong either way. Each
 * path resolves independently, and the caller receives both halves of the answer.
 *
 * Re-claiming a path this dispatch already holds succeeds, so a worker that reports
 * the same scope twice (a retry, or a follow-up dispatch narrowing its own claims) is
 * not blocked by its own earlier claim.
 */
export function claimWorkerFiles(
  this: OrchestrationDb,
  params: {
    runId: string
    workspaceId: string
    dispatchId: string
    paths: readonly string[]
    flavor: ClaimPathFlavor
  }
): ClaimWorkerFilesResult {
  const { runId, workspaceId, dispatchId, paths, flavor } = params
  const granted: WorkerFileClaimRow[] = []
  const refused: RefusedFileClaim[] = []
  const seen = new Set<string>()

  this.db.exec('BEGIN IMMEDIATE')
  try {
    for (const path of paths) {
      let claimKey: string
      try {
        claimKey = toClaimPathKey(path, flavor)
      } catch (error) {
        // Why refuse rather than throw: one malformed path in a list should not discard the
        // claims its siblings earned. The refusal names the path so the worker can correct it.
        this.db.exec('ROLLBACK')
        if (error instanceof ClaimPathError) {
          this.db.exec('BEGIN IMMEDIATE')
          refused.push({
            claimKey: path,
            displayPath: path,
            heldByDispatchId: null
          })
          continue
        }
        throw error
      }
      if (seen.has(claimKey)) {
        continue
      }
      seen.add(claimKey)

      const conflicts = findConflicts
        .call(this, runId, workspaceId, claimKey)
        .filter((row) => row.dispatch_id !== dispatchId)
      if (conflicts.length > 0) {
        refused.push({
          claimKey,
          displayPath: path,
          heldByDispatchId: conflicts[0].dispatch_id
        })
        continue
      }

      this.db
        .prepare(
          `INSERT INTO worker_file_claims
             (run_id, workspace_id, claim_key, display_path, dispatch_id)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(run_id, workspace_id, claim_key) DO UPDATE SET
             display_path = excluded.display_path,
             claimed_at = datetime('now')`
        )
        .run(runId, workspaceId, claimKey, path, dispatchId)
      const row = readClaimRow.call(this, runId, workspaceId, claimKey)
      if (row) {
        granted.push(row)
      }
    }
    this.db.exec('COMMIT')
    return { granted, refused }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

/** Every claim in one workspace, for the coordinator's worker-start preamble and the UI. */
export function listWorkerFileClaims(
  this: OrchestrationDb,
  params: { runId: string; workspaceId: string }
): WorkerFileClaimRow[] {
  return toClaimRows(
    this.db
      .prepare(
        'SELECT * FROM worker_file_claims WHERE run_id = ? AND workspace_id = ? ORDER BY claim_key'
      )
      .all(params.runId, params.workspaceId)
  )
}

/** Claims held by one dispatch, so its coordinator can show what it owns. */
export function listFileClaimsForDispatch(
  this: OrchestrationDb,
  dispatchId: string
): WorkerFileClaimRow[] {
  return toClaimRows(
    this.db
      .prepare('SELECT * FROM worker_file_claims WHERE dispatch_id = ? ORDER BY claim_key')
      .all(dispatchId)
  )
}

/**
 * Paths a worker may not touch, given what the others hold.
 *
 * Why a read-only check beside the write: a worker must be able to ask "is this mine?"
 * before editing, and after a settlement the answer changes without the worker asking
 * for a new claim. A held path is never silently released - release is explicit.
 */
export function findConflictingFileClaims(
  this: OrchestrationDb,
  params: {
    runId: string
    workspaceId: string
    dispatchId: string
    paths: readonly string[]
    flavor: ClaimPathFlavor
  }
): RefusedFileClaim[] {
  const conflicts: RefusedFileClaim[] = []
  for (const path of params.paths) {
    let claimKey: string
    try {
      claimKey = toClaimPathKey(path, params.flavor)
    } catch (error) {
      if (error instanceof ClaimPathError) {
        conflicts.push({ claimKey: path, displayPath: path, heldByDispatchId: null })
        continue
      }
      throw error
    }
    const held = findConflicts
      .call(this, params.runId, params.workspaceId, claimKey)
      .filter((row) => row.dispatch_id !== params.dispatchId)
    if (held.length > 0) {
      conflicts.push({
        claimKey,
        displayPath: path,
        heldByDispatchId: held[0].dispatch_id
      })
    }
  }
  return conflicts
}

/**
 * Drop a dispatch's claims, so a settled worker stops blocking its peers.
 *
 * Why settlement and not the caller's say-so: a claim outlives the worker that made
 * it only as long as that worker is live, and the dispatch row is what decides that.
 * Releasing on an abandon leaves the next worker free, and releasing on a reuse keeps
 * the same dispatch's ownership intact.
 */
export function releaseFileClaimsForDispatch(this: OrchestrationDb, dispatchId: string): number {
  // Why Number(): the driver types `changes` as number | bigint even though a row
  // count is never bigint here, and callers should not have to narrow it.
  return Number(
    this.db.prepare('DELETE FROM worker_file_claims WHERE dispatch_id = ?').run(dispatchId).changes
  )
}

export function releaseFileClaimsForRun(this: OrchestrationDb, runId: string): number {
  return Number(
    this.db.prepare('DELETE FROM worker_file_claims WHERE run_id = ?').run(runId).changes
  )
}

/** Refusal text naming the other worker, so a blocked claim is actionable in a terminal. */
export function fileClaimRefusalMessage(refusals: readonly RefusedFileClaim[]): string {
  if (refusals.length === 0) {
    return ''
  }
  const lines = refusals.map((refusal) =>
    refusal.heldByDispatchId
      ? `- ${refusal.displayPath} is already claimed by dispatch ${refusal.heldByDispatchId}`
      : `- ${refusal.displayPath} cannot be claimed (${refusal.claimKey})`
  )
  const count = refusals.length
  return [
    `${count} path${count === 1 ? '' : 's'} could not be claimed:`,
    ...lines,
    'Work only on the paths you hold, or negotiate a boundary with the holder before editing.'
  ].join('\n')
}

export function throwOnRefusedFileClaims(refusals: readonly RefusedFileClaim[]): void {
  if (refusals.length === 0) {
    return
  }
  throw new OrchestrationError('file_claim_conflict', fileClaimRefusalMessage(refusals), {
    effectsApplied: false,
    refusals
  })
}

export type FileClaimStoreMethods = {
  claimWorkerFiles: typeof claimWorkerFiles
  listWorkerFileClaims: typeof listWorkerFileClaims
  listFileClaimsForDispatch: typeof listFileClaimsForDispatch
  findConflictingFileClaims: typeof findConflictingFileClaims
  releaseFileClaimsForDispatch: typeof releaseFileClaimsForDispatch
  releaseFileClaimsForRun: typeof releaseFileClaimsForRun
  throwOnRefusedFileClaims: typeof throwOnRefusedFileClaims
}

export function attachFileClaimStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    claimWorkerFiles,
    listWorkerFileClaims,
    listFileClaimsForDispatch,
    findConflictingFileClaims,
    releaseFileClaimsForDispatch,
    releaseFileClaimsForRun,
    throwOnRefusedFileClaims
  })
}
