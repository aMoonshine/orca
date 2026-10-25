import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTeamConfiguration } from '../../shared/agent-team-configuration'
import {
  agentTeamPresetKey,
  readAgentTeamPresets,
  writeAgentTeamPresets
} from './agent-team-presets'

const configuration: AgentTeamConfiguration = {
  leader: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  profiles: [
    {
      id: 'code',
      agent: 'codex',
      model: 'unlisted-exact-model',
      effort: 'high',
      purpose: 'Implement'
    },
    { id: 'review', agent: 'claude', model: 'opus', effort: 'low', purpose: 'Review' },
    { id: 'free', agent: 'opencode', model: 'opencode/big-pickle', purpose: 'Research' }
  ],
  parallelismHint: 12
}
const presets = [{ id: 'mixed', name: 'Mixed team', configuration }]

beforeEach(() => {
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value)
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('agent team presets', () => {
  it('roundtrips mixed profiles, exact unlisted models, optional efforts and an advisory hint', () => {
    writeAgentTeamPresets('presets', presets)
    expect(readAgentTeamPresets('presets')).toEqual(presets)
    expect(readAgentTeamPresets('presets')[0].configuration.profiles[2]).not.toHaveProperty(
      'effort'
    )
    const loaded = readAgentTeamPresets('presets')
    loaded[0].configuration.profiles[0].model = 'edited'
    expect(readAgentTeamPresets('presets')).toEqual(presets)
  })

  it('isolates local, remote and folder workspace keys without delimiter collisions', () => {
    const keys = [
      agentTeamPresetKey({ kind: 'local' }, 'folder:project'),
      agentTeamPresetKey({ kind: 'environment', environmentId: 'local' }, 'folder:project'),
      agentTeamPresetKey({ kind: 'environment', environmentId: 'server-a' }, 'folder:project'),
      agentTeamPresetKey({ kind: 'environment', environmentId: 'server-b' }, 'folder:project'),
      agentTeamPresetKey({ kind: 'local' }, 'folder:other'),
      agentTeamPresetKey({ kind: 'environment', environmentId: 'a.b' }, 'c'),
      agentTeamPresetKey({ kind: 'environment', environmentId: 'a' }, 'b.c')
    ]
    expect(new Set(keys).size).toBe(keys.length)
    writeAgentTeamPresets(keys[0], presets)
    expect(readAgentTeamPresets(keys[0])).toEqual(presets)
    for (const key of keys.slice(1)) {
      expect(readAgentTeamPresets(key)).toEqual([])
    }
  })

  it.each([
    'broken JSON',
    'null',
    JSON.stringify({ version: 2, presets }),
    JSON.stringify({ version: 1, presets: [{ ...presets[0], configuration: {} }] }),
    JSON.stringify({ version: 1, presets: [presets[0], presets[0]] }),
    JSON.stringify({
      version: 1,
      presets: [{ ...presets[0], configuration: { ...configuration, parallelismHint: 0 } }]
    })
  ])('safely ignores malformed or unsupported storage: %s', (payload) => {
    localStorage.setItem('presets', payload)
    expect(readAgentTeamPresets('presets')).toEqual([])
  })

  it('persists only the named configuration fields', () => {
    const configurationWithContext = {
      ...configuration,
      objective: 'private task',
      sessionId: 'session-secret',
      token: 'secret'
    }
    writeAgentTeamPresets('presets', [
      {
        ...presets[0],
        configuration: configurationWithContext
      }
    ])
    const stored = localStorage.getItem('presets')
    expect(stored).not.toContain('private task')
    expect(stored).not.toContain('session-secret')
    expect(stored).not.toContain('token')
  })

  it('keeps valid presets when a separate entry is stale or malformed', () => {
    localStorage.setItem(
      'presets',
      JSON.stringify({
        version: 1,
        presets: [{ id: 'broken', name: 'Old', configuration: {} }, ...presets]
      })
    )
    expect(readAgentTeamPresets('presets')).toEqual(presets)
  })

  it('tolerates inaccessible reads and surfaces failed writes', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('Storage blocked')
      },
      setItem: () => {
        throw new Error('Quota exceeded')
      }
    })
    expect(readAgentTeamPresets('presets')).toEqual([])
    expect(() => writeAgentTeamPresets('presets', presets)).toThrow('Quota exceeded')
  })
})
