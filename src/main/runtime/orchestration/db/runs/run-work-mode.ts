import {
  firstPhaseFor,
  isAgentWorkMode,
  nextPhaseFor,
  phaseAllowsAnotherRound,
  phaseDefinition,
  type AgentWorkMode,
  type ModePhase
} from '../../../../../shared/swarm/mode-protocols'
import { OrchestrationError } from '../../orchestration-error'
import type { RunRow } from '../../types'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

export type RunPhaseRow = {
  id: string
  run_id: string
  mode: AgentWorkMode
  phase: string
  phase_round: number
  entered_at: string
  advanced_by: string | null
  note: string
}

/** The mode and phase a Run is in, with the phase's rules already resolved. */
export type RunWorkMode = {
  mode: AgentWorkMode
  phaseId: string
  round: number
  definition: ModePhase
  isFinalPhase: boolean
}

function readModeColumns(row: RunRow): {
  mode: AgentWorkMode
  phaseId: string
  round: number
} {
  // Why re-validate rather than trust the column: a mode can only be ADDed by
  // migration, never constrained after the fact, and a hand-edited or downgraded
  // profile could hold anything. Falling back to solo/work keeps such a Run usable
  // instead of failing every later call.
  const mode: AgentWorkMode = isAgentWorkMode(row.mode) ? row.mode : 'solo'
  const stored = typeof row.mode_phase === 'string' ? row.mode_phase : ''
  const phase = phaseDefinition(mode, stored) ?? firstPhaseFor(mode)
  const round =
    Number.isInteger(row.mode_phase_round) && row.mode_phase_round > 0 ? row.mode_phase_round : 1
  return { mode, phaseId: phase.id, round }
}

/**
 * The Run's current mode and phase.
 *
 * This is the single read every mode-aware path goes through, so the phase that a
 * worker is told about and the phase that a claim is checked against cannot drift.
 */
export function getRunWorkMode(this: OrchestrationDb, runId: string): RunWorkMode {
  const run = this.getRun(runId)
  if (!run) {
    throw new OrchestrationError('run_not_found', `Run ${runId} was not found.`)
  }
  return buildWorkMode(run)
}

function buildWorkMode(run: RunRow): RunWorkMode {
  const { mode, phaseId, round } = readModeColumns(run)
  const definition = phaseDefinition(mode, phaseId) ?? firstPhaseFor(mode)
  return {
    mode,
    phaseId: definition.id,
    round,
    definition,
    isFinalPhase: nextPhaseFor(mode, definition.id) === undefined
  }
}

/**
 * Put a Run into a mode, starting at that mode's first phase.
 *
 * Why re-entering a mode resets the phase instead of resuming the old one: the two
 * modes have different protocols, and a fusion panel resuming a swarm's catch-up
 * round would be nonsense. The history is kept so the reset is visible.
 */
export function setRunWorkMode(
  this: OrchestrationDb,
  params: { runId: string; mode: AgentWorkMode; advancedBy?: string; note?: string }
): RunWorkMode {
  if (!isAgentWorkMode(params.mode)) {
    throw new OrchestrationError('invalid_argument', `Unknown work mode ${String(params.mode)}.`)
  }
  this.requireRun(params.runId)
  const phase = firstPhaseFor(params.mode)
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.db
      .prepare(
        "UPDATE runs SET mode = ?, mode_phase = ?, mode_phase_round = 1, updated_at = datetime('now') WHERE id = ?"
      )
      .run(params.mode, phase.id, params.runId)
    recordPhaseEvent.call(this, {
      runId: params.runId,
      mode: params.mode,
      phase: phase.id,
      round: 1,
      advancedBy: params.advancedBy,
      note: params.note ?? ''
    })
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return this.getRunWorkMode(params.runId)
}

/**
 * Move to the next phase of the protocol.
 *
 * Re-entering the same phase is allowed only while its round budget lasts, which is
 * what makes the spec's catch-up a bounded loop instead of an endless debate. Moving
 * forward from the last phase is refused rather than silently wrapping, because a Run
 * that has finished its protocol has not failed — it is done.
 */
export function advanceRunPhase(
  this: OrchestrationDb,
  params: { runId: string; advancedBy?: string; note?: string }
): RunWorkMode {
  const current = this.getRunWorkMode(params.runId)
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const next = nextPhaseFor(current.mode, current.phaseId)
    if (next) {
      this.db
        .prepare(
          "UPDATE runs SET mode_phase = ?, mode_phase_round = 1, updated_at = datetime('now') WHERE id = ?"
        )
        .run(next.id, params.runId)
      recordPhaseEvent.call(this, {
        runId: params.runId,
        mode: current.mode,
        phase: next.id,
        round: 1,
        advancedBy: params.advancedBy,
        note: params.note ?? ''
      })
      this.db.exec('COMMIT')
      return this.getRunWorkMode(params.runId)
    }
    if (!phaseAllowsAnotherRound(current.definition, current.round)) {
      throw new OrchestrationError(
        'phase_round_exhausted',
        `${MODE_LABEL[current.mode]} phase ${current.definition.label} is at its round limit (${current.round}); the protocol is finished.`
      )
    }
    const round = current.round + 1
    this.db
      .prepare("UPDATE runs SET mode_phase_round = ?, updated_at = datetime('now') WHERE id = ?")
      .run(round, params.runId)
    recordPhaseEvent.call(this, {
      runId: params.runId,
      mode: current.mode,
      phase: current.phaseId,
      round,
      advancedBy: params.advancedBy,
      note: params.note ?? ''
    })
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return this.getRunWorkMode(params.runId)
}

const MODE_LABEL: Record<AgentWorkMode, string> = {
  solo: 'Solo',
  fusion: 'Fusion',
  orchestrator: 'Orchestrator',
  swarm: 'Swarm'
}

function recordPhaseEvent(
  this: OrchestrationDb,
  params: {
    runId: string
    mode: AgentWorkMode
    phase: string
    round: number
    advancedBy?: string
    note?: string
  }
): void {
  this.db
    .prepare(
      `INSERT INTO run_phase_events
         (id, run_id, mode, phase, phase_round, advanced_by, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      generateId('rpe'),
      params.runId,
      params.mode,
      params.phase,
      params.round,
      params.advancedBy ?? null,
      params.note ?? ''
    )
}

export function listRunPhaseEvents(this: OrchestrationDb, runId: string): RunPhaseRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over run_phase_events returns the columns this file's schema declares, and RunPhaseRow names each of them.
  return this.db
    .prepare('SELECT * FROM run_phase_events WHERE run_id = ? ORDER BY entered_at, rowid')
    .all(runId) as RunPhaseRow[]
}

/**
 * Whether a worker in this phase may take file ownership.
 *
 * The one rule that makes three of the spec's read-only phases enforceable: a fusion
 * panelist, a swarm coordination phase, and an orchestrator planning phase all resolve
 * to the same check. Returns the refusal text as well as the boolean so the caller can
 * put the phase's own name in front of the worker instead of a bare "not allowed".
 */
export function runPhaseAllowsFileClaims(
  this: OrchestrationDb,
  runId: string
): { allowed: true } | { allowed: false; reason: string } {
  const current = this.getRunWorkMode(runId)
  if (current.definition.allowsFileClaims) {
    return { allowed: true }
  }
  return {
    allowed: false,
    reason:
      `${MODE_LABEL[current.mode]} phase ${current.definition.label} is read-only for every worker. ` +
      'No worker may claim or edit a file until the coordinator advances the Run to the next phase.'
  }
}

export type RunWorkModeMethods = {
  getRunWorkMode: typeof getRunWorkMode
  setRunWorkMode: typeof setRunWorkMode
  advanceRunPhase: typeof advanceRunPhase
  listRunPhaseEvents: typeof listRunPhaseEvents
  runPhaseAllowsFileClaims: typeof runPhaseAllowsFileClaims
}

export function attachRunWorkMode(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getRunWorkMode,
    setRunWorkMode,
    advanceRunPhase,
    listRunPhaseEvents,
    runPhaseAllowsFileClaims
  })
}
