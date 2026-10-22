import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadGroupDraft, saveGroupDraft, type AgentGroupDraft } from './agent-group-draft'

describe('agent group draft', () => {
  beforeEach(() => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value)
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('loads old persisted workers without inventing model or effort preferences', () => {
    const oldDraft = {
      mode: 'swarm',
      objective: 'Review a folder workspace',
      workers: [{ id: 'old-worker', agent: 'codex', spec: 'Review', claims: '' }]
    }
    localStorage.setItem('draft', JSON.stringify(oldDraft))
    expect(loadGroupDraft('draft')).toEqual(oldDraft)
  })

  it('roundtrips mixed exact models and optional efforts per worker', () => {
    const draft: AgentGroupDraft = {
      mode: 'swarm',
      objective: 'Review this project',
      workers: [
        {
          id: 'codex',
          agent: 'codex',
          model: 'gpt-6.1-sol',
          effort: 'high',
          spec: 'Code',
          claims: ''
        },
        { id: 'claude', agent: 'claude', model: 'opus', effort: 'low', spec: 'Tests', claims: '' },
        { id: 'free', agent: 'opencode', model: 'opencode/big-pickle', spec: 'Docs', claims: '' },
        { id: 'defaults', agent: 'gemini', model: '', spec: 'Review', claims: '' }
      ]
    }
    saveGroupDraft('draft', draft)
    expect(loadGroupDraft('draft')).toEqual(draft)
    expect(loadGroupDraft('draft')?.workers[2]).not.toHaveProperty('effort')
    expect(loadGroupDraft('draft')?.workers[3]).not.toHaveProperty('effort')
  })
})
