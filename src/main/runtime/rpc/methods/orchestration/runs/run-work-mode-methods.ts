import { defineMethod } from '../../../core'
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
    permission: 'workspace',
    params: RunModeParams,
    handler: (params, { runtime, orchestrationCaller, orchestrationCompatibilityEvidence }) => {
      const db = runtime.getOrchestrationDb()
      const run = resolveRunScope(runtime, {
        runId: params.id,
        callerTerminalHandle: params.from,
        callerSession: orchestrationCaller,
        callerEvidence: orchestrationCompatibilityEvidence,
        requireCurrentConsumer: false
      })
      return { workMode: db.getRunWorkMode(run.id), phases: db.listRunPhaseEvents(run.id) }
    }
  }),
  defineMethod({
    name: 'orchestration.runModeSet',
    permission: 'workspace',
    params: RunModeSetParams,
    handler: (params, { runtime, orchestrationCaller, orchestrationCompatibilityEvidence }) => {
      const db = runtime.getOrchestrationDb()
      const run = resolveRunScope(runtime, {
        runId: params.id,
        callerTerminalHandle: params.from,
        callerSession: orchestrationCaller,
        callerEvidence: orchestrationCompatibilityEvidence,
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
    permission: 'workspace',
    params: RunPhaseAdvanceParams,
    handler: (params, { runtime, orchestrationCaller, orchestrationCompatibilityEvidence }) => {
      const db = runtime.getOrchestrationDb()
      const run = resolveRunScope(runtime, {
        runId: params.id,
        callerTerminalHandle: params.from,
        callerSession: orchestrationCaller,
        callerEvidence: orchestrationCompatibilityEvidence,
        requireCurrentConsumer: true
      })
      const workMode = db.advanceRunPhase({ runId: run.id, advancedBy: params.from })
      return { workMode, phases: db.listRunPhaseEvents(run.id) }
    }
  })
]
