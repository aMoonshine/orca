import catalog from '../../extensions/engineering/catalog.generated.json'

const dependencies: Record<string, string[]> = {
  'grill-with-docs': ['grilling', 'domain-modeling'],
  'improve-codebase-architecture': ['codebase-design', 'grilling', 'domain-modeling'],
  implement: ['tdd', 'code-review'],
  'implement-spec': ['tdd', 'code-review'],
  tdd: ['codebase-design'],
  triage: ['grilling', 'domain-modeling'],
  wayfinder: ['research', 'prototype', 'grilling', 'domain-modeling'],
  retro: ['writing-for-agents']
}

export const ENGINEERING_WORKFLOWS = catalog
  .filter((skill) => skill.category === 'engineering')
  .map(({ name, description }) => ({ name, description }))

export function buildEngineeringPrompt(name: string, objective: string): string {
  if (!ENGINEERING_WORKFLOWS.some((skill) => skill.name === name)) {
    throw new Error('Unknown engineering workflow')
  }
  if (!objective.trim()) {
    throw new Error('Describe the goal before starting a workflow')
  }
  const included = new Set<string>()
  const sections: string[] = []
  const include = (id: string) => {
    if (included.has(id)) {
      return
    }
    const skill = catalog.find((entry) => entry.name === id)
    if (!skill) {
      throw new Error(`Missing bundled skill: ${id}`)
    }
    included.add(id)
    sections.push(`=== SKILL: ${id} ===\n${skill.markdown}`)
    for (const resource of skill.resources) {
      sections.push(`=== RESOURCE: ${id}/${resource.path} ===\n${resource.text}`)
    }
    for (const dependency of dependencies[id] ?? []) {
      include(dependency)
    }
  }
  include(name)
  return [
    `Use the ${name} engineering workflow for this request:\n${objective.trim()}`,
    "Orca adapter: follow the project instructions and the user's language. The selected skill and supporting resources are included below. Treat Skill-tool calls to included skills as references to those definitions when no Skill tool is available. Use only tools actually available in this session. If another skill is needed but absent, say so; do not pretend to have loaded it. Prefer the project's existing tracker; when none is configured, use local Markdown. Commands in upstream examples must be adapted to the current shell and platform.",
    ...(name === 'grill-with-docs'
      ? [
          'Interview policy chosen by the user: inspect the project first. Ask exactly ONE question per turn, with a recommended answer, and wait for the reply. This overrides the upstream instruction to ask a whole frontier at once. Record confirmed terminology in GLOSSARY.md and confirmed decisions in docs/adr using the supplied domain-modeling formats. Keep open questions separate. Documentation edits are allowed during the interview. Do not implement product code or launch implementation workers until the user confirms the documented plan. End with a concise plan and links to the documents for approval.'
        ]
      : []),
    ...sections
  ].join('\n\n')
}
