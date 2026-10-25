// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentTeamConfiguration } from '../../shared/agent-team-configuration'
import { readAgentTeamPresets, writeAgentTeamPresets } from '../lib/agent-team-presets'
import { AgentTeamPresets } from './AgentTeamPresets'

const configuration: AgentTeamConfiguration = {
  leader: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  profiles: [{ id: 'free', agent: 'opencode', model: 'opencode/big-pickle', purpose: 'Research' }],
  parallelismHint: 8
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function save(name = 'My team') {
  fireEvent.change(screen.getByLabelText('Preset name'), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: 'Save as' }))
}

describe('AgentTeamPresets', () => {
  it('saves, loads an independent configuration and deletes a named preset', () => {
    const onLoad = vi.fn((loaded: AgentTeamConfiguration) => {
      loaded.profiles[0].model = 'changed'
    })
    const draft = structuredClone(configuration)
    render(
      <AgentTeamPresets
        storageKey="local-folder"
        configuration={draft}
        disabled={false}
        onLoad={onLoad}
      />
    )
    save('  My team  ')
    draft.leader.model = 'draft-edited'
    expect(readAgentTeamPresets('local-folder')[0].name).toBe('My team')
    expect(screen.getByRole('combobox').textContent).toContain('My team')
    fireEvent.click(screen.getByRole('button', { name: 'Load' }))
    expect(onLoad).toHaveBeenCalledTimes(1)
    expect(readAgentTeamPresets('local-folder')[0].configuration).toEqual(configuration)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(readAgentTeamPresets('local-folder')).toEqual([])
    expect(screen.getByRole('button', { name: 'Load' }).hasAttribute('disabled')).toBe(true)
  })

  it('lists persisted presets and loads exact unlisted model IDs', () => {
    const saved = {
      ...configuration,
      leader: { agent: 'codex' as const, model: 'unlisted-exact-id', effort: 'high' }
    }
    writeAgentTeamPresets('key', [{ id: 'saved', name: 'Saved team', configuration: saved }])
    const onLoad = vi.fn()
    render(
      <AgentTeamPresets storageKey="key" configuration={null} disabled={false} onLoad={onLoad} />
    )
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByRole('option', { name: 'Saved team' }))
    fireEvent.click(screen.getByRole('button', { name: 'Load' }))
    expect(onLoad).toHaveBeenCalledWith(saved)
  })

  it('disables all operations while busy and save when configuration is invalid', () => {
    const props = { storageKey: 'key', configuration, disabled: false, onLoad: vi.fn() }
    const view = render(<AgentTeamPresets {...props} />)
    save()
    view.rerender(<AgentTeamPresets {...props} disabled />)
    for (const button of screen.getAllByRole('button')) {
      expect(button.hasAttribute('disabled')).toBe(true)
    }
    expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Load' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(props.onLoad).not.toHaveBeenCalled()
    expect(readAgentTeamPresets('key')).toHaveLength(1)
    view.rerender(<AgentTeamPresets {...props} configuration={null} />)
    expect(screen.getByRole('button', { name: 'Save as' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Load' }).hasAttribute('disabled')).toBe(false)
  })

  it('clears selection, name and stored list when host or workspace changes', () => {
    const props = { configuration, disabled: false, onLoad: vi.fn() }
    const view = render(<AgentTeamPresets {...props} storageKey="host-a-folder" />)
    save()
    fireEvent.change(screen.getByLabelText('Preset name'), { target: { value: 'Unfinished name' } })
    view.rerender(<AgentTeamPresets {...props} storageKey="host-b-folder" />)
    expect(screen.getByLabelText('Preset name').getAttribute('value')).toBe('')
    expect(screen.getByRole('button', { name: 'Load' }).hasAttribute('disabled')).toBe(true)
    expect(readAgentTeamPresets('host-b-folder')).toEqual([])
    expect(readAgentTeamPresets('host-a-folder')).toHaveLength(1)
  })

  it('rejects duplicate names and keeps saved presets on failed save or delete', () => {
    render(
      <AgentTeamPresets
        storageKey="key"
        configuration={configuration}
        disabled={false}
        onLoad={vi.fn()}
      />
    )
    save()
    fireEvent.change(screen.getByLabelText('Preset name'), { target: { value: 'MY TEAM' } })
    expect(screen.getByRole('button', { name: 'Save as' }).hasAttribute('disabled')).toBe(true)
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded')
    })
    save('Another team')
    expect(screen.getByRole('alert').textContent).toContain('Could not save presets')
    expect(readAgentTeamPresets('key')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('combobox').textContent).toContain('My team')
    expect(readAgentTeamPresets('key')).toHaveLength(1)
  })
})
