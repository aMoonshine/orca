import { describe, expect, it } from 'vitest'
import type { AgentTeamConfiguration } from './agent-team-configuration'
import { buildAgentTeamPrompt } from './agent-team-prompt'

const configuration: AgentTeamConfiguration = {
  leader: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  profiles: [
    {
      id: 'free',
      agent: 'opencode',
      model: 'opencode/space-bunny-free',
      purpose: 'Routine implementation'
    },
    {
      id: 'reasoning',
      agent: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
      purpose: 'Difficult diagnosis'
    },
    {
      id: 'review',
      agent: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'medium',
      purpose: 'Focused review'
    }
  ],
  parallelismHint: 6
}

describe('team manager bootstrap', () => {
  it('offers exact mixed profiles for task-level selection without premium fallback', () => {
    const prompt = buildAgentTeamPrompt({ objective: '  Find parser bugs  ', configuration })

    expect(prompt).toContain('Requested goal:\nFind parser bugs\n')
    expect(prompt).toContain(`Master configuration: ${JSON.stringify(configuration.leader)}`)
    expect(
      prompt
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
    ).toEqual(configuration.profiles)
    expect(prompt).toContain('--agent "opencode" --model "opencode/space-bunny-free".')
    expect(prompt).toContain('--agent "codex" --model "gpt-6.1-sol" --effort "high".')
    expect(prompt).toContain('--agent "codex" --model "gpt-6.1-sol" --effort "medium".')
    expect(prompt).toContain('Omit --effort: this profile has no explicit effort.')
    expect(prompt).toContain('Choose an available profile separately for each task')
    expect(prompt).toContain('mix Codex and OpenCode profiles and different configured efforts')
    expect(prompt).toContain(
      'Never silently substitute models or broaden the allowed profile models'
    )
    expect(prompt).toContain('Free-model selections must remain exact: no premium fallback')
  })

  it('uses a hint above 20 solely as pace guidance', () => {
    const prompt = buildAgentTeamPrompt({
      objective: 'Review',
      configuration: { ...configuration, parallelismHint: 48 }
    })

    expect(prompt).toContain('Initial parallelismHint: 48')
    expect(prompt).toContain(
      'pace guidance only, not a fixed task count or a hard concurrency ceiling'
    )
    expect(prompt).toContain('You may use fewer or more agents and tasks')
    expect(prompt).not.toMatch(/Decompose the goal into \d+|Keep at most|maximum of \d+ workers/)
  })

  it('preserves scope, phases, claims, lifecycle verification and cleanup', () => {
    const prompt = buildAgentTeamPrompt({ objective: 'Review without editing', configuration })

    expect(prompt).toContain('do not explore or edit sibling repositories')
    expect(prompt).toContain('For bug review stay in its read-only coordination phase')
    expect(prompt).toContain('non-overlapping --claims')
    expect(prompt).toContain('Create Task rows before dispatch')
    expect(prompt).toContain('Task and Dispatch records are the source of truth')
    expect(prompt).toContain('check --wait for worker_done, question and escalation')
    expect(prompt).toContain('Process each delivery before acknowledging')
    expect(prompt).toContain('then close completed worker panels with worker-release')
    expect(prompt).toContain('worker-retain')
    expect(prompt).toContain('Preserve the master chat and user-taken-over sessions')
    expect(prompt).toContain('never blindly relaunch an unknown outcome')
  })

  it('omits model and effort flags for a provider using its CLI configuration', () => {
    const prompt = buildAgentTeamPrompt({
      objective: 'Review',
      configuration: {
        ...configuration,
        profiles: [{ id: 'default', agent: 'gemini', model: '', purpose: 'Review' }]
      }
    })

    expect(prompt).toContain('Launch preferences: --agent "gemini".')
    expect(prompt).toContain('Omit --model: this provider uses the model configured in its CLI')
    expect(prompt).not.toContain('--model ""')
    expect(prompt).not.toContain('--effort "')
  })

  it('rejects an empty objective and invalid configuration at the prompt boundary', () => {
    expect(() => buildAgentTeamPrompt({ objective: '  ', configuration })).toThrow('Choose a goal')
    expect(() =>
      buildAgentTeamPrompt({
        objective: 'Review',
        configuration: { ...configuration, profiles: [] }
      })
    ).toThrow()
    expect(() =>
      buildAgentTeamPrompt({
        objective: 'Review',
        configuration: {
          ...configuration,
          profiles: [{ ...configuration.profiles[0], effort: 'high' }]
        }
      })
    ).toThrow('does not support effort high')
  })
})
