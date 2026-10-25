import { z } from 'zod'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import { checkAgentLaunchModelPreferences } from '../../../../shared/agent-launch-model-preferences'

const choiceSchema = z.object({
  agent: z.custom<TuiAgent>((value) => typeof value === 'string' && isTuiAgent(value)),
  model: z.string().trim(),
  effort: z.string().trim().min(1).optional()
})

export const agentTeamConfigurationSchema = z
  .object({
    leader: choiceSchema,
    profiles: z.array(choiceSchema.extend({ id: z.string().min(1), purpose: z.string() })).min(1),
    parallelismHint: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .superRefine((configuration, context) => {
    const choices = [
      { choice: configuration.leader, path: ['leader'] },
      ...configuration.profiles.map((choice, index) => ({ choice, path: ['profiles', index] }))
    ]
    for (const { choice, path } of choices) {
      if (
        getAgentSessionOptionCatalog(choice.agent)?.supportsWorkerLaunchPreferences &&
        !choice.model
      ) {
        context.addIssue({
          code: 'custom',
          path: [...path, 'model'],
          message: 'Choose an exact model.'
        })
        continue
      }
      const result = checkAgentLaunchModelPreferences({
        ...choice,
        // This validates configuration only; worker-start still verifies the execution host CLI.
        openCodeModelLaunchSupported: true
      })
      if ('refusal' in result) {
        context.addIssue({ code: 'custom', path, message: result.refusal.message })
      }
    }
    if (
      new Set(configuration.profiles.map((profile) => profile.id)).size !==
      configuration.profiles.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['profiles'],
        message: 'Worker profile IDs must be unique.'
      })
    }
  })

export type AgentTeamConfiguration = z.infer<typeof agentTeamConfigurationSchema>
export type AgentTeamChoice = AgentTeamConfiguration['leader']
export type AgentTeamProfile = AgentTeamConfiguration['profiles'][number]
