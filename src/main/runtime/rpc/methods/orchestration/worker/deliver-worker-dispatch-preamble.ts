import type { RuntimeTerminalSend } from '../../../../../../shared/runtime-terminal-contracts'
import { MODE_PROTOCOLS } from '../../../../../../shared/swarm/mode-protocols'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RunWorkMode } from '../../../../orchestration/db/runs/run-work-mode'
import {
  buildDispatchPreamble,
  dispatchPreambleSendOptions
} from '../../../../orchestration/preamble'
import { sendStructuredWorkerPreamble } from '../../orchestration-structured-worker-session'
import type { WorkerTurnStartObservation } from './worker-start-turn-observation'
import type { WorkerFileClaimOutcome } from './worker-start-file-claims'
import type { createStructuredWorkerSessionForWorktree } from './worker-topology'

type StructuredSession = Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>> | null

/**
 * Hands a started worker the dispatch preamble, over whichever transport it has.
 *
 * The preamble itself is identical for both: a worker is taught the same verbs whichever mode it
 * runs in, and only the delivery differs — a PTY write returns a queued/accepted receipt, while a
 * structured turn is acknowledged, still held for an agent that has not started, or throws. Held is
 * a turn start nobody observed yet: the start is left unknown, not torn down.
 */
export async function deliverWorkerDispatchPreamble(args: {
  runtime: OrcaRuntimeService
  structuredSession: StructuredSession
  terminalHandle: string
  dispatchId: string
  dispatchDepth: number
  taskId: string
  taskSpec: string
  coordinatorHandle: string
  dispatchCapability: string
  devMode: boolean | undefined
  requestId: string
  fileClaims?: WorkerFileClaimOutcome
  workMode?: RunWorkMode
}): Promise<{
  prompt?: RuntimeTerminalSend['prompt']
  structuredTurnStart?: WorkerTurnStartObservation
}> {
  const { runtime, structuredSession, terminalHandle } = args
  const preamble = buildDispatchPreamble({
    // Depth only. A worker is taught the same verbs whichever mode it runs in, so this must not
    // become a second gate: resolving the caller's worktree is what lets a structured worker
    // dispatch sub-workers exactly like a PTY one.
    canDispatchSubWorkers: args.dispatchDepth < runtime.getNestedWorkerMaxDepth(),
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    taskSpec: args.taskSpec,
    coordinatorHandle: args.coordinatorHandle,
    workerHandle: terminalHandle,
    dispatchCapability: args.dispatchCapability,
    devMode: args.devMode,
    cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle),
    fileClaims: args.fileClaims
      ? {
          owned: args.fileClaims.claims,
          ownedByOthers: args.fileClaims.ownedByOthers
        }
      : undefined,
    workMode: args.workMode
      ? {
          modeLabel: MODE_PROTOCOLS[args.workMode.mode].label,
          phaseLabel: args.workMode.definition.label,
          phaseInstruction: args.workMode.definition.instruction,
          round: args.workMode.round,
          isFinalPhase: args.workMode.isFinalPhase
        }
      : undefined
  })
  if (structuredSession) {
    const delivery = await sendStructuredWorkerPreamble({
      host: structuredSession.host,
      sessionId: structuredSession.identity.sessionId,
      dispatchId: args.dispatchId,
      preamble
    })
    return {
      structuredTurnStart:
        delivery === 'accepted'
          ? { verdict: 'observed' }
          : {
              verdict: 'unobserved',
              reason:
                'The dispatch preamble was accepted, but the agent had not started to take it. It ' +
                'is delivered when the agent starts; if the worker then reports, this Dispatch ' +
                'settles normally.'
            }
    }
  }
  return {
    prompt: (
      await runtime.sendTerminalAgentPrompt(
        terminalHandle,
        preamble,
        dispatchPreambleSendOptions(args.requestId)
      )
    ).prompt
  }
}
