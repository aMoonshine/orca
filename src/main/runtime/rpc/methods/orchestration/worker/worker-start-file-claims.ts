import { isCaseInsensitiveRuntimeRoot } from '../../../../../../shared/cross-platform-path'
import type { ClaimPathFlavor } from '../../../../../../shared/swarm/file-claim-path-key'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerFileClaimRow } from '../../../../orchestration/db/file-claims/file-claim-store'

/**
 * Why the root path decides case, not the running host: a workspace reached over SSH
 * or WSL lives on the remote filesystem, so the local OS says nothing useful about it.
 * `isCaseInsensitiveRuntimeRoot` already encodes the Windows-vs-WSL-UNC-vs-POSIX
 * answer for a given root, so the flavor is a property of where the files are.
 */
export function claimPathFlavorForWorkspace(workspacePath: string): ClaimPathFlavor {
  return isCaseInsensitiveRuntimeRoot(workspacePath) ? 'case_insensitive' : 'case_sensitive'
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

/**
 * Record a starting worker's file ownership, refusing a path a peer already holds.
 *
 * Why this runs at worker-start rather than at the first edit: the whole failure this
 * prevents is two agents believing the same file is theirs, and a check after the
 * first write is already too late to stop the clobber. Refusing the dispatch is the
 * only point where the coordinator still has a choice — the alternative is a worker
 * that has been told to stop after it has already started changing files.
 *
 * Returns the sibling claims so the preamble can name them. A worker is more likely to
 * respect a named owner than a rule, and the coordinator can use the same list to
 * re-split the task rather than just fail.
 */
export function claimWorkerStartFiles(args: {
  db: OrchestrationDb
  runId: string
  dispatchId: string
  workspaceId: string
  workspacePath: string
  claims: string | undefined
}): WorkerFileClaimOutcome {
  const paths = parseClaimPaths(args.claims)
  if (paths.length === 0) {
    return { claims: [], ownedByOthers: [] }
  }
  // Why before the DB write: the phase gate is what makes a mode's read-only phase
  // real. A fusion panelist, a swarm coordination phase and an orchestrator planning
  // phase all resolve here, so "do not write any file" stops being a sentence in a
  // prompt and becomes a refusal. Checking after the claim would leave a row the
  // worker already believes it owns.
  const phase = args.db.runPhaseAllowsFileClaims(args.runId)
  if (!phase.allowed) {
    throw new OrchestrationError('file_claim_phase_read_only', phase.reason, {
      effectsApplied: false,
      runId: args.runId
    })
  }
  const flavor = claimPathFlavorForWorkspace(args.workspacePath)
  const scope = { runId: args.runId, workspaceId: args.workspaceId }

  const result = args.db.claimWorkerFiles({
    ...scope,
    dispatchId: args.dispatchId,
    paths,
    flavor
  })
  args.db.throwOnRefusedFileClaims(result.refused)

  return {
    claims: result.granted,
    ownedByOthers: args.db
      .listWorkerFileClaims(scope)
      .filter((row) => row.dispatch_id !== args.dispatchId)
  }
}
