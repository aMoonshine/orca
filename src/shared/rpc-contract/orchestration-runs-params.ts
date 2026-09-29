import { z } from 'zod'
import { OptionalBoolean, OptionalString, requiredString } from './rpc-param-primitives'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../orchestration-run-pagination'

export const RunCreateParams = z.object({
  objective: requiredString('Missing --objective'),
  from: requiredString('Missing coordinator terminal'),
  /**
   * How this group of workers relates to each other. It lives on the Run, not on a
   * worker, which is why a launch-many control composes with it instead of competing:
   * the mode says how the group works, the control says how many join it.
   */
  mode: z.enum(['solo', 'fusion', 'orchestrator', 'swarm']).optional()
})

export const RunUseParams = z.object({
  id: requiredString('Missing --id'),
  from: requiredString('Missing coordinator terminal'),
  takeoverLegacy: OptionalBoolean
})

export const RunCurrentParams = z.object({ from: requiredString('Missing coordinator terminal') })

export const RunListParams = z.object({
  limit: z.number().int().min(1).max(ORCHESTRATION_RUN_PAGE_LIMIT).optional(),
  cursor: z.string().min(1).optional()
})

export const RunShowParams = z.object({ id: requiredString('Missing --id'), from: OptionalString })

export const RunModeParams = z.object({
  from: requiredString('Missing coordinator terminal'),
  id: OptionalString
})

export const RunModeSetParams = z.object({
  from: requiredString('Missing coordinator terminal'),
  id: OptionalString,
  mode: z.enum(['solo', 'fusion', 'orchestrator', 'swarm'])
})

export const RunPhaseAdvanceParams = z.object({
  from: requiredString('Missing coordinator terminal'),
  id: OptionalString
})
