import { describe, expect, it } from 'vitest'
import { buildEngineeringPrompt, ENGINEERING_WORKFLOWS } from './engineering-workflow'

describe('engineering workflows', () => {
  it('exposes all twenty engineering skills', () => {
    expect(ENGINEERING_WORKFLOWS).toHaveLength(20)
    for (const workflow of ENGINEERING_WORKFLOWS) {
      expect(buildEngineeringPrompt(workflow.name, 'Improve this project')).toContain(
        `=== SKILL: ${workflow.name} ===`
      )
    }
  })
  it('provides the interview dependencies and document formats without implementation skills', () => {
    const prompt = buildEngineeringPrompt('grill-with-docs', 'Build an importer')
    expect(prompt).toContain('=== SKILL: grilling ===')
    expect(prompt).toContain('=== SKILL: domain-modeling ===')
    expect(prompt).toContain('ADR-FORMAT.md')
    expect(prompt).toContain('GLOSSARY-FORMAT.md')
    expect(prompt).toContain('exactly ONE question per turn')
    expect(prompt).toContain('until the user confirms the documented plan')
    expect(prompt).not.toContain('=== SKILL: implement ===')
  })
  it('rejects invalid workflows and missing goals', () => {
    expect(() => buildEngineeringPrompt('unknown', 'goal')).toThrow('Unknown')
    expect(() => buildEngineeringPrompt('grill-with-docs', ' ')).toThrow('Describe')
  })
  it('includes executable templates as readable resources for the wizard', () => {
    expect(buildEngineeringPrompt('wizard', 'Configure this project')).toContain(
      '=== RESOURCE: wizard/template.sh ==='
    )
  })
})
