import { defineMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { resolveRunScope } from './run-scope'
import {
  RunModeParams,
  RunModeSetParams,
  RunPhaseAdvanceParams
} from '../../../../../../shared/rpc-contract/orchestration-runs-params'

/**
 * The mode of a Run is the coordinator's to set and the coordinator's to advance, because a
 * phase change is a release of a read-only hold: it is the moment peers are told they may
 * edit. `requireCurrentConsumer` is what keeps a worker from promoting its own Run's phase
 * to skip the coordination round.
 */
export const ORCHESTRATION_RUN_WORK_MODE_METHODS = [
  defineMethod({
    name: 'orchestration.runMode',
    params: RunModeParams,
    handler: (params, { runtime, orchestrationCaller }) => {
      const db = runtime.getOrchestrationDb()
      const run = resolveRunScope(runtime, {
        runId: params.id,
        callerTerminalHandle: params.from,
        callerSession: orchestrationCaller,
        requireCurrentConsumer: false
      })
      return { workMode: db.getRunWorkMode(run.id), phases: db.listRunPhaseEvents(run.id) }
    }
  }),
  defineMethod({
    name: 'orchestration.runModeSet',
    params: RunModeSetParams,
    handler: (params, { runtime, orchestrationCaller }) => {
      const db = runtime.getOrchestrationDb()
      const run = resolveRunScope(runtime, {
        runId: params.id,
        callerTerminalHandle: params.from,
        callerSession: orchestrationCaller,
        requireCurrentConsumer: true
      })
      const workMode = db.setRunWorkMode({
        runId: run.id,
        mode: params.mode,
        advancedBy: params.from
      })
      return { workMode, phases: db.listRunPhaseEvents(run.id) }
    }
  }),
  defineMethod({
    name: 'orchestration.runPhaseAdvance',
    params: RunPhaseAdvanceParams,
    handler: (params, { runtime, orchestrationCaller }) => {
      const db = runtime.getOrchestrationDb()
      const run = resolveRunScope(runtime, {
        runId: params.id,
        callerTerminalHandle: params.from,
        callerSession: orchestrationCaller,
        requireCurrentConsumer: true
      })
      const before = db.getRunWorkMode(run.id)
      if (before.isFinalPhase) {
        throw new OrchestrationError(
          'phase_round_exhausted',
          `${before.definition.label} is the last phase of ${before.mode}; there is nothing to advance to.`,
          { effectsApplied: false }
        )
      }
      const workMode = db.advanceRunPhase({ runId: run.id, advancedBy: params.from })
      return { workMode, phases: db.listRunPhaseEvents(run.id) }
    }
  })
]
