import type { RunRow } from '../../types'
import { firstPhaseFor, type AgentWorkMode } from '../../../../../shared/swarm/mode-protocols'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'
import type { OrcaSessionId } from '../../../../../shared/orca-session-address'
import { mailboxAddressOf } from '../../orchestration-caller-identity'

// ── Runs ──

export function createRun(
  this: OrchestrationDb,
  params: {
    objective: string
    coordinatorHandle: string | null
    coordinatorPaneKey: string | null
    /** The coordinator's bare Orca session id when it is a structured session; see orca-session-address. */
    coordinatorOrcaSessionId?: OrcaSessionId | null
    /** Defaults to solo, which is the mode a pre-mode Run always was. */
    mode?: AgentWorkMode
  }
): RunRow {
  const coordinator = {
    terminalHandle: params.coordinatorHandle,
    paneKey: params.coordinatorPaneKey,
    orcaSessionId: params.coordinatorOrcaSessionId ?? null
  }
  const id = generateId('run')
  const mode = params.mode ?? 'solo'
  const phase = firstPhaseFor(mode)
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.unbindOtherRunsForCoordinator(coordinator)
    this.db
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_handle, coordinator_pane_key, coordinator_orca_session_id,
           coordinator_orca_session_id_generation, consumer_generation, legacy,
           mode, mode_phase, mode_phase_round
         ) VALUES (?, ?, ?, ?, ?, 1, 1, 0, ?, ?, 1)`
      )
      .run(
        id,
        params.objective,
        coordinator.terminalHandle,
        coordinator.paneKey,
        coordinator.orcaSessionId,
        mode,
        phase.id
      )
    const address = mailboxAddressOf(coordinator)
    if (address !== null) {
      this.rememberRunCoordinatorHandle(id, address)
    }
    // Recorded on create, not on the first setRunWorkMode: the phase a Run starts in is
    // part of how it was created, and a coordinator asking for its history should see it.
    this.db
      .prepare(
        `INSERT INTO run_phase_events
           (id, run_id, mode, phase, phase_round, advanced_by, note)
         VALUES (?, ?, ?, ?, 1, ?, ?)`
      )
      .run(generateId('rpe'), id, mode, phase.id, coordinator.terminalHandle, 'run created')
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return this.getRun(id) as RunRow
}

export type RunCreateMethods = {
  createRun: typeof createRun
}

export function attachRunCreate(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createRun
  })
}
