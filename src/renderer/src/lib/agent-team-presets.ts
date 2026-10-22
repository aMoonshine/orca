import { z } from 'zod'
import {
  agentTeamConfigurationSchema,
  type AgentTeamConfiguration
} from '../../../shared/agent-team-configuration'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

export type AgentTeamPreset = {
  id: string
  name: string
  configuration: AgentTeamConfiguration
}

const presetSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  configuration: agentTeamConfigurationSchema
})
const storageSchema = z.object({
  version: z.literal(1),
  presets: z.array(presetSchema).refine((presets) => {
    return new Set(presets.map((preset) => preset.id)).size === presets.length
  })
})

export function agentTeamPresetKey(target: RuntimeClientTarget, worktreeId: string): string {
  const host = target.kind === 'local' ? ['local'] : ['environment', target.environmentId]
  return `orca.agent-team-presets.${JSON.stringify([...host, worktreeId])}`
}

export function readAgentTeamPresets(key: string): AgentTeamPreset[] {
  try {
    const envelope = z
      .object({ version: z.literal(1), presets: z.array(z.unknown()) })
      .parse(JSON.parse(localStorage.getItem(key) ?? 'null'))
    const presets = envelope.presets.flatMap((entry) => {
      const parsed = presetSchema.safeParse(entry)
      return parsed.success ? [parsed.data] : []
    })
    return presets.filter(
      (preset) => presets.filter((entry) => entry.id === preset.id).length === 1
    )
  } catch {
    return []
  }
}

export function writeAgentTeamPresets(key: string, presets: AgentTeamPreset[]): void {
  const payload = storageSchema.parse({ version: 1, presets })
  localStorage.setItem(key, JSON.stringify(payload))
}
