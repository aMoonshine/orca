import { describe, expect, it } from 'vitest'
import {
  AGENT_WORK_MODES,
  firstPhaseFor,
  isAgentWorkMode,
  MODE_PROTOCOLS,
  nextPhaseFor,
  phaseAllowsAnotherRound
} from '../../../../../shared/swarm/mode-protocols'
import { OrchestrationDb } from '../../db'
import { OrchestrationError } from '../../orchestration-error'

/**
 * The store's own guard is unreachable through the RPC surface, where the param enum
 * rejects the value first. It is still the last line of defence for any future internal
 * caller, so the test drives it directly and marks the type hole rather than hiding it.
 */
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deliberately passing a mode outside AgentWorkMode to prove the store validates at runtime.
const unknownMode = 'mothership' as Parameters<OrchestrationDb['setRunWorkMode']>[0]['mode']

/**
 * The mode layer, per agent-to-agent.md. Two things are being pinned here: the phase
 * protocols are shaped as the spec describes, and the read-only phases are actually
 * refused rather than only described in a prompt.
 */
describe('mode protocols', () => {
  it('defines the four modes in the spec matrix', () => {
    expect([...AGENT_WORK_MODES].sort()).toEqual(['fusion', 'orchestrator', 'solo', 'swarm'])
  })

  it('gives Swarm its three phases with a read-only start and a bounded catch-up', () => {
    const phases = MODE_PROTOCOLS.swarm.phases
    expect(phases.map((phase) => phase.id)).toEqual(['coordination', 'implementation', 'catchup'])
    // The spec's "code edits are forbidden" in phase 1.
    expect(phases[0].allowsFileClaims).toBe(false)
    expect(phases[1].allowsFileClaims).toBe(true)
    // The spec's round limit that stops an endless debate.
    expect(phases[2].maxRounds).toBe(2)
  })

  it('gives Fusion a read-only panel and judge, and one writer', () => {
    const phases = MODE_PROTOCOLS.fusion.phases
    expect(phases.map((phase) => phase.id)).toEqual(['panel', 'judge', 'integration'])
    // A panelist that could claim a file would break the isolation the mode is for.
    expect(phases[0].allowsFileClaims).toBe(false)
    expect(phases[0].allowsDecisions).toBe(false)
    expect(phases[1].allowsFileClaims).toBe(false)
    expect(phases.filter((phase) => phase.allowsFileClaims)).toHaveLength(1)
  })

  it('gives Orchestrator a read-only planning phase and isolated workers', () => {
    const phases = MODE_PROTOCOLS.orchestrator.phases
    expect(phases.map((phase) => phase.id)).toEqual(['planning', 'implementation', 'integration'])
    expect(phases[0].allowsFileClaims).toBe(false)
  })

  it('leaves Solo unphased in effect, and write-enabled', () => {
    expect(MODE_PROTOCOLS.solo.phases).toHaveLength(1)
    expect(MODE_PROTOCOLS.solo.phases[0].allowsFileClaims).toBe(true)
  })

  it('rejects a mode name it does not know', () => {
    expect(isAgentWorkMode('swarm')).toBe(true)
    expect(isAgentWorkMode('mothership')).toBe(false)
  })

  it('walks forward and reports the end of the protocol', () => {
    expect(nextPhaseFor('swarm', 'coordination')?.id).toBe('implementation')
    expect(nextPhaseFor('swarm', 'catchup')).toBeUndefined()
    expect(firstPhaseFor('fusion').id).toBe('panel')
  })

  it('allows extra rounds only while the phase budget lasts', () => {
    const catchup = MODE_PROTOCOLS.swarm.phases[2]
    expect(phaseAllowsAnotherRound(catchup, 1)).toBe(true)
    expect(phaseAllowsAnotherRound(catchup, 2)).toBe(false)
    // A phase with no budget never repeats.
    expect(phaseAllowsAnotherRound(MODE_PROTOCOLS.swarm.phases[0], 1)).toBe(false)
  })
})

describe('run work mode', () => {
  function swarmRun() {
    const db = new OrchestrationDb(':memory:')
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
    return { db, runId: run.id }
  }

  it('starts a Run at its mode first phase and records that in the history', () => {
    const { db, runId } = swarmRun()
    const current = db.getRunWorkMode(runId)

    expect(current.mode).toBe('swarm')
    expect(current.phaseId).toBe('coordination')
    expect(current.round).toBe(1)
    const history = db.listRunPhaseEvents(runId)
    expect(history).toHaveLength(1)
    expect(history[0].phase).toBe('coordination')
    db.close()
  })

  it('refuses file claims during the read-only coordination phase', () => {
    const { db, runId } = swarmRun()

    const gate = db.runPhaseAllowsFileClaims(runId)
    expect(gate.allowed).toBe(false)
    expect(gate.allowed === false && gate.reason).toMatch(/Swarm phase Coordination is read-only/)
    db.close()
  })

  it('lets a coordinator advance the phase and then allows claims', () => {
    const { db, runId } = swarmRun()
    const advanced = db.advanceRunPhase({ runId, advancedBy: 'term_coord' })

    expect(advanced.phaseId).toBe('implementation')
    expect(db.runPhaseAllowsFileClaims(runId)).toEqual({ allowed: true })
    expect(db.listRunPhaseEvents(runId).map((row) => row.phase)).toEqual([
      'coordination',
      'implementation'
    ])
    db.close()
  })

  it('bounds the catch-up rounds and then reports the protocol is finished', () => {
    const { db, runId } = swarmRun()
    db.advanceRunPhase({ runId })
    db.advanceRunPhase({ runId })
    expect(db.getRunWorkMode(runId).phaseId).toBe('catchup')

    const second = db.advanceRunPhase({ runId })
    expect(second.phaseId).toBe('catchup')
    expect(second.round).toBe(2)

    let caught: OrchestrationError | undefined
    try {
      db.advanceRunPhase({ runId })
    } catch (error) {
      if (error instanceof OrchestrationError) {
        caught = error
      }
    }
    expect(caught?.code).toBe('phase_round_exhausted')
    expect(caught?.message).toMatch(/round limit/)
    db.close()
  })

  it('switches a Run to another mode starting at that mode first phase', () => {
    const { db, runId } = swarmRun()
    const switched = db.setRunWorkMode({ runId, mode: 'fusion', advancedBy: 'term_coord' })

    expect(switched.mode).toBe('fusion')
    expect(switched.phaseId).toBe('panel')
    expect(switched.round).toBe(1)
    // A fusion panel is read-only, so the gate must follow the mode change.
    expect(db.runPhaseAllowsFileClaims(runId).allowed).toBe(false)
    db.close()
  })

  it('rejects a mode it does not know', () => {
    const { db, runId } = swarmRun()
    let caught: OrchestrationError | undefined
    try {
      db.setRunWorkMode({ runId, mode: unknownMode })
    } catch (error) {
      if (error instanceof OrchestrationError) {
        caught = error
      }
    }
    expect(caught?.code).toBe('invalid_argument')
    db.close()
  })

  it('treats a Run with no mode as solo, so pre-mode profiles stay usable', () => {
    const db = new OrchestrationDb(':memory:')
    db.createRun({
      objective: 'Legacy run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf'
    })
    const run = db.getCurrentRunForCoordinator({
      terminalHandle: 'term_coord',
      paneKey: 'tab_coord:leaf',
      orcaSessionId: null
    })
    if (!run) {
      throw new Error('expected a bound run')
    }
    const current = db.getRunWorkMode(run.id)
    expect(current.mode).toBe('solo')
    expect(current.phaseId).toBe('work')
    db.close()
  })
})
