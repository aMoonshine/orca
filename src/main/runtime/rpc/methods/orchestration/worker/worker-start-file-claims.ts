import { isCaseInsensitiveRuntimeRoot } from '../../../../../../shared/cross-platform-path'
import { isWslUncPath } from '../../../../../../shared/wsl-paths'
import type { ClaimPathFlavor } from '../../../../../../shared/swarm/file-claim-path-key'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerFileClaimRow } from '../../../../orchestration/db/file-claims/file-claim-store'
import {
  beginLifecycleWriteTransaction,
  commitLifecycleWriteTransaction,
  rollbackLifecycleWriteTransaction
} from '../../../../orchestration/db/lifecycle-transition'

// Resolve on the execution host; macOS and unknown roots conservatively fold case.
export function claimPathFlavorForWorkspace(workspacePath: string): ClaimPathFlavor {
  if (isCaseInsensitiveRuntimeRoot(workspacePath)) {
    return 'case_insensitive'
  }
  if (isWslUncPath(workspacePath) || process.platform === 'linux') {
    return 'case_sensitive'
  }
  return 'case_insensitive'
}

/**
 * `--claims` is a comma-separated list to match `--deps` and `--options`, so one flag
 * can name a worker's whole file set. Entries are trimmed and empties dropped, because a
 * trailing comma in a shell variable is common and an empty path key has no meaning.
 */
export function parseClaimPaths(claims: string | undefined): string[] {
  if (!claims) {
    return []
  }
  return claims
    .split(',')
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
}

export type WorkerFileClaimOutcome = {
  /** Empty when the worker named no paths, which is the common single-agent case. */
  claims: WorkerFileClaimRow[]
  /** Paths owned by this dispatch and by its siblings, for the injected preamble. */
  ownedByOthers: WorkerFileClaimRow[]
}

/** Admit claims before task delivery; claims do not restrict filesystem writes. */
type WorkerStartFileClaimArgs = {
  db: OrchestrationDb
  runId: string
  dispatchId: string
  claims: string | undefined
}

type PlacedWorkerStartFileClaimArgs = WorkerStartFileClaimArgs & {
  workspaceId: string
  workspacePath: string
}

export function claimWorkerStartFiles(
  args: PlacedWorkerStartFileClaimArgs
): WorkerFileClaimOutcome {
  if (parseClaimPaths(args.claims).length === 0) {
    return { claims: [], ownedByOthers: [] }
  }
  if (!args.workspaceId || !args.workspacePath) {
    throw new OrchestrationError(
      'invalid_argument',
      'File claims require a resolved workspace ID and path.',
      { effectsApplied: false }
    )
  }
  return claimStartingWorkerFiles({
    ...args,
    flavor: claimPathFlavorForWorkspace(args.workspacePath)
  })
}

// New workspaces have no filesystem identity until placement; their reservation is private.
export function reserveWorkerStartFiles(args: WorkerStartFileClaimArgs): WorkerFileClaimOutcome {
  return claimStartingWorkerFiles({
    ...args,
    workspaceId: `pending-workspace:${args.dispatchId}`,
    flavor: 'case_sensitive'
  })
}

export function bindWorkerStartFiles(args: PlacedWorkerStartFileClaimArgs): WorkerFileClaimOutcome {
  if (parseClaimPaths(args.claims).length === 0) {
    return { claims: [], ownedByOthers: [] }
  }
  const transaction = beginLifecycleWriteTransaction(args.db.db, 'bind_worker_start_files')
  try {
    const worker = args.db.getWorkerDispatch(args.dispatchId)
    const reserved = args.db.listFileClaimsForDispatch(args.dispatchId)
    if (
      (worker && worker.state !== 'starting') ||
      reserved.length === 0 ||
      reserved.some((claim) => claim.workspace_id !== `pending-workspace:${args.dispatchId}`)
    ) {
      throw new OrchestrationError(
        'dispatch_inactive',
        'Only a starting worker reservation can bind to a new workspace.'
      )
    }
    args.db.releaseFileClaimsForDispatch(args.dispatchId)
    const result = claimWorkerStartFiles(args)
    commitLifecycleWriteTransaction(args.db.db, transaction)
    return result
  } catch (error) {
    rollbackLifecycleWriteTransaction(args.db.db, transaction)
    throw error
  }
}

function claimStartingWorkerFiles(
  args: WorkerStartFileClaimArgs & { workspaceId: string; flavor: ClaimPathFlavor }
): WorkerFileClaimOutcome {
  const paths = parseClaimPaths(args.claims)
  if (paths.length === 0) {
    return { claims: [], ownedByOthers: [] }
  }
  const transaction = beginLifecycleWriteTransaction(args.db.db, 'claim_starting_worker_files')
  try {
    // Read-only phases refuse claim admission before placement or prompt delivery.
    const phase = args.db.runPhaseAllowsFileClaims(args.runId)
    if (!phase.allowed) {
      throw new OrchestrationError('file_claim_phase_read_only', phase.reason, {
        effectsApplied: false,
        runId: args.runId
      })
    }
    const scope = { runId: args.runId, workspaceId: args.workspaceId }

    const result = args.db.claimWorkerFiles({
      ...scope,
      dispatchId: args.dispatchId,
      paths,
      flavor: args.flavor
    })
    args.db.throwOnRefusedFileClaims(result.refused)

    const outcome = {
      claims: result.granted,
      ownedByOthers: args.db
        .listWorkerFileClaims(scope)
        .filter((row) => row.dispatch_id !== args.dispatchId)
    }
    commitLifecycleWriteTransaction(args.db.db, transaction)
    return outcome
  } catch (error) {
    rollbackLifecycleWriteTransaction(args.db.db, transaction)
    throw error
  }
}
