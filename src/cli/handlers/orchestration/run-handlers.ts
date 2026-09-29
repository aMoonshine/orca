import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../../flags'
import {
  AGENT_WORK_MODES,
  isAgentWorkMode,
  type AgentWorkMode
} from '../../../shared/swarm/mode-protocols'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../../shared/orchestration-run-pagination'
import { RuntimeClientError } from '../../runtime-client'
import { callOrchestrationMutation } from './mutation-request'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'

/** Fail closed on a typo'd mode instead of forwarding it for the host to reject. */
function readWorkModeFlag(flags: Map<string, string | boolean>): string | undefined {
  const raw = getOptionalStringFlag(flags, 'mode')
  if (raw !== undefined && !isAgentWorkMode(raw)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown --mode ${raw}. Expected one of: ${AGENT_WORK_MODES.join(', ')}.`
    )
  }
  return raw
}

function optionalWorkModeFlag(flags: Map<string, string | boolean>): AgentWorkMode | undefined {
  const raw = readWorkModeFlag(flags)
  return raw !== undefined && isAgentWorkMode(raw) ? raw : undefined
}

function requiredWorkModeFlag(flags: Map<string, string | boolean>): AgentWorkMode {
  const mode = optionalWorkModeFlag(flags)
  if (!mode) {
    throw new RuntimeClientError('invalid_argument', 'Missing --mode')
  }
  return mode
}

type RunWorkModeReceipt = {
  workMode: { mode: string; phaseId: string; round: number; isFinalPhase: boolean }
  phases: { phase: string; phase_round: number }[]
}

function printWorkMode(receipt: RunWorkModeReceipt): string {
  const current = receipt.workMode
  const final = current.isFinalPhase ? ' (final phase)' : ''
  const history = receipt.phases.map((row) => `  ${row.phase} round ${row.phase_round}`).join('\n')
  return `${current.mode} / ${current.phaseId} round ${current.round}${final}\nPhases entered:\n${history}`
}

export const ORCHESTRATION_RUN_HANDLERS: Record<string, CommandHandler> = {
  'orchestration run-create': async ({ flags, client, cwd, json }) => {
    // Validated before the terminal lookup: a typo'd mode should not cost an RPC round trip.
    const mode = optionalWorkModeFlag(flags)
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<{
      run: { id: string; objective: string; consumer_generation: number }
    }>(client, flags, 'orchestration.runCreate', {
      objective: getRequiredStringFlag(flags, 'objective'),
      from,
      // Omitted entirely when unset, so the host default (solo) stays host-side.
      ...(mode ? { mode } : {})
    })
    printResult(result, json, (r) => `Run ${r.run.id} created and bound: ${r.run.objective}`)
  },

  'orchestration run-use': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<{
      run: { id: string; objective: string; consumer_generation: number }
    }>(client, flags, 'orchestration.runUse', {
      id: getRequiredStringFlag(flags, 'id'),
      from,
      ...(flags.has('takeover-legacy') ? { takeoverLegacy: true } : {})
    })
    printResult(result, json, (r) => `Using Run ${r.run.id}: ${r.run.objective}`)
  },

  'orchestration run-current': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      run: { id: string; objective: string } | null
    }>('orchestration.runCurrent', { from })
    printResult(result, json, (r) =>
      r.run
        ? `${r.run.id} ${r.run.objective}`
        : `No Run is bound to this ${from === undefined ? 'session' : 'terminal'}.`
    )
  },

  'orchestration run-list': async ({ flags, client, json }) => {
    const result = await client.call<{
      runs: { id: string; objective: string; legacy: number }[]
      nextCursor: string | null
    }>('orchestration.runList', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit') ?? ORCHESTRATION_RUN_PAGE_LIMIT,
      cursor: getOptionalStringFlag(flags, 'cursor')
    })
    printResult(result, json, (r) => {
      const rows =
        r.runs.length === 0
          ? 'No Runs found.'
          : r.runs
              .map(
                (run) => `${run.id}${run.legacy ? ' [legacy, inspect only]' : ''} ${run.objective}`
              )
              .join('\n')
      return r.nextCursor ? `${rows}\nMore Runs: --cursor ${r.nextCursor}` : rows
    })
  },

  'orchestration run-show': async ({ flags, client, json }) => {
    const result = await client.call<{
      run: {
        id: string
        objective: string
        consumer_generation: number
        legacy: number
        created_at: string
      }
    }>('orchestration.runShow', { id: getRequiredStringFlag(flags, 'id') })
    printResult(
      result,
      json,
      (r) =>
        `${r.run.id}${r.run.legacy ? ' [legacy, inspect only]' : ''} ${r.run.objective}\n` +
        `consumer generation ${r.run.consumer_generation}; created ${r.run.created_at}`
    )
  },

  'orchestration run-mode': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<RunWorkModeReceipt>('orchestration.runMode', {
      from,
      id: getOptionalStringFlag(flags, 'id')
    })
    printResult(result, json, printWorkMode)
  },

  'orchestration run-mode-set': async ({ flags, client, cwd, json }) => {
    const mode = requiredWorkModeFlag(flags)
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<RunWorkModeReceipt>(
      client,
      flags,
      'orchestration.runModeSet',
      { from, id: getOptionalStringFlag(flags, 'id'), mode }
    )
    printResult(result, json, (r) => `Mode set. ${printWorkMode(r).split('\n')[0] ?? ''}`.trim())
  },

  'orchestration run-phase-advance': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<RunWorkModeReceipt>(
      client,
      flags,
      'orchestration.runPhaseAdvance',
      { from, id: getOptionalStringFlag(flags, 'id') }
    )
    printResult(result, json, (r) =>
      `Phase advanced. ${printWorkMode(r).split('\n')[0] ?? ''}`.trim()
    )
  }
}
