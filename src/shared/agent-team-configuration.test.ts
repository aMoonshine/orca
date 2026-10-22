import { describe, expect, it } from 'vitest'
import { agentTeamConfigurationSchema } from './agent-team-configuration'

const configuration = {
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
    }
  ],
  parallelismHint: 48
}

describe('agent team configuration contract', () => {
  it('preserves exact mixed profiles, optional effort and a hint above 20', () => {
    const parsed = agentTeamConfigurationSchema.parse(configuration)

    expect(parsed).toEqual(configuration)
    expect(parsed.profiles[0]).not.toHaveProperty('effort')
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid pace hint %s',
    (parallelismHint) => {
      expect(
        agentTeamConfigurationSchema.safeParse({ ...configuration, parallelismHint }).success
      ).toBe(false)
    }
  )

  it('rejects missing profiles and duplicate profile identities', () => {
    expect(agentTeamConfigurationSchema.safeParse({ ...configuration, profiles: [] }).success).toBe(
      false
    )
    expect(() =>
      agentTeamConfigurationSchema.parse({
        ...configuration,
        profiles: configuration.profiles.map((profile) => ({ ...profile, id: 'duplicate' }))
      })
    ).toThrow('Worker profile IDs must be unique')
  })

  it.each([
    { agent: 'opencode', model: '', effort: undefined },
    { agent: 'opencode', model: 'opencode/space-bunny-free', effort: 'high' },
    { agent: 'codex', model: 'gpt-6.1-sol', effort: 'invented-effort' },
    { agent: 'gemini', model: 'explicit/model', effort: undefined },
    { agent: 'gemini', model: '', effort: 'high' },
    { agent: 'unknown-provider', model: 'exact/model', effort: undefined }
  ])('rejects unsupported launch preferences for $agent/$model/$effort', (choice) => {
    expect(
      agentTeamConfigurationSchema.safeParse({ ...configuration, leader: choice }).success
    ).toBe(false)
    expect(
      agentTeamConfigurationSchema.safeParse({
        ...configuration,
        profiles: [{ id: 'invalid', purpose: 'Review', ...choice }]
      }).success
    ).toBe(false)
  })

  it('accepts CLI defaults without inventing a model or effort', () => {
    const choice = { agent: 'gemini', model: '' }
    const input = {
      ...configuration,
      leader: choice,
      profiles: [{ id: 'default', purpose: 'Review', ...choice }]
    }

    expect(agentTeamConfigurationSchema.parse(input)).toEqual(input)
  })
})
