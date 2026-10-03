import { describe, expect, it } from 'vitest'
import { buildAgentTeamPrompt } from './agent-team-prompt'

describe('team manager bootstrap', () => {
  it('carries the exact worker model, goal, scope and retained-session policy', () => {
    const prompt = buildAgentTeamPrompt({
      objective: 'Find parser bugs without editing',
      agent: 'opencode',
      model: 'provider/exact-model',
      count: 6
    })
    expect(prompt).toContain('provider/exact-model')
    expect(prompt).toContain('Find parser bugs without editing')
    expect(prompt).toContain('worker-retain')
    expect(prompt).toContain('do not explore or edit sibling repositories')
    expect(prompt).toContain('check --wait')
    expect(prompt).toContain('Create Task rows before dispatch')
  })
  it.each([0, 21, 1.5, Number.NaN])('rejects invalid team size %s', (count) => {
    expect(() =>
      buildAgentTeamPrompt({ objective: 'Review', agent: 'opencode', model: 'p/m', count })
    ).toThrow()
  })
})
