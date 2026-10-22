// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TabAgentLaunchOption } from '../tab-bar/tab-agent-launch-options'
import { agentTeamPresetKey, writeAgentTeamPresets } from '@/lib/agent-team-presets'
import type { AgentTeamConfiguration } from '../../../../shared/agent-team-configuration'

const mocks = vi.hoisted(() => ({ start: vi.fn(), models: vi.fn() }))
vi.mock('@/lib/agent-team-session', () => ({
  readTeamSession: () => null,
  teamSessionKey: () => 'test-team',
  startAgentTeam: mocks.start
}))
vi.mock('@/lib/agent-group-model-discovery', () => ({
  agentGroupModelDiscoveryContextKey: () => 'test',
  loadAgentGroupModels: mocks.models
}))
vi.mock('./AgentTeamBoard', () => ({ AgentTeamBoard: () => null }))
import { AgentTeamControl } from './AgentTeamControl'

const gemini: TabAgentLaunchOption = {
  agent: 'gemini',
  label: 'Gemini CLI',
  aliases: [],
  row: { kind: 'cli', agent: 'gemini' }
}
const codex: TabAgentLaunchOption = { agent: 'codex', label: 'Codex', aliases: [] }
const opencode: TabAgentLaunchOption = { agent: 'opencode', label: 'OpenCode', aliases: [] }
const props = { target: { kind: 'local' as const }, worktreeId: 'folder:test', onClose: vi.fn() }
const mixed: AgentTeamConfiguration = {
  leader: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  profiles: [
    { id: 'free', agent: 'opencode', model: 'opencode/big-pickle', purpose: 'Routine work' },
    {
      id: 'complex',
      agent: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
      purpose: 'Complex implementation'
    }
  ],
  parallelismHint: 32
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mocks.start.mockResolvedValue(undefined)
  mocks.models.mockResolvedValue([])
})
afterEach(cleanup)

describe('team launch choices', () => {
  it('recovers from empty async inventory and launches Gemini with CLI defaults', async () => {
    const view = render(<AgentTeamControl {...props} options={[]} />)
    fireEvent.change(screen.getByLabelText('What should the team do?'), {
      target: { value: 'Review parser' }
    })
    expect(screen.getByRole('button', { name: 'Start team' }).hasAttribute('disabled')).toBe(true)
    view.rerender(<AgentTeamControl {...props} options={[gemini]} />)
    await waitFor(() =>
      expect(screen.getAllByRole('combobox', { name: 'Agent 1 provider' })).toHaveLength(2)
    )
    const start = screen.getByRole('button', { name: 'Start team' })
    expect(start.hasAttribute('disabled')).toBe(false)
    fireEvent.click(start)
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({
          configuration: {
            leader: { agent: 'gemini', model: '' },
            profiles: [{ id: 'team-worker', agent: 'gemini', model: '', purpose: '' }],
            parallelismHint: 6
          },
          objective: 'Review parser'
        })
      )
    )
  })

  it('requires exact supported models and preserves them when inventory order changes', async () => {
    const view = render(<AgentTeamControl {...props} options={[codex]} />)
    fireEvent.change(screen.getByLabelText('What should the team do?'), {
      target: { value: 'Build parser' }
    })
    await waitFor(() =>
      expect(screen.getAllByPlaceholderText('Enter an exact model ID')).toHaveLength(2)
    )
    const inputs = screen.getAllByPlaceholderText('Enter an exact model ID')
    fireEvent.change(inputs[0], { target: { value: 'exact/master' } })
    expect(screen.getByRole('button', { name: 'Start team' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(inputs[1], { target: { value: 'exact/worker' } })
    view.rerender(<AgentTeamControl {...props} options={[gemini, codex]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start team' }))
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({
          configuration: expect.objectContaining({
            leader: { agent: 'codex', model: 'exact/master' },
            profiles: [{ id: 'team-worker', agent: 'codex', model: 'exact/worker', purpose: '' }]
          })
        })
      )
    )
  })

  it('loads a mixed preset without changing its exact models, effort, purpose or soft pace', async () => {
    writeAgentTeamPresets(agentTeamPresetKey(props.target, props.worktreeId), [
      { id: 'mixed', name: 'Mixed team', configuration: mixed }
    ])
    const view = render(<AgentTeamControl {...props} options={[codex, opencode]} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Team presets' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Mixed team' }))
    fireEvent.click(screen.getByRole('button', { name: 'Load' }))
    fireEvent.change(screen.getByLabelText('What should the team do?'), {
      target: { value: 'Build parser' }
    })
    expect(screen.getByLabelText('Approximate concurrency / pace').getAttribute('max')).toBeNull()
    expect(screen.getByDisplayValue('Routine work')).toBeTruthy()
    view.rerender(<AgentTeamControl {...props} options={[opencode, codex]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start team' }))
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith({
        target: props.target,
        worktreeId: props.worktreeId,
        objective: 'Build parser',
        configuration: mixed
      })
    )
  })

  it('preserves an unavailable preset provider and blocks launch on the current host', async () => {
    writeAgentTeamPresets(agentTeamPresetKey(props.target, props.worktreeId), [
      { id: 'mixed', name: 'Mixed team', configuration: mixed }
    ])
    const view = render(<AgentTeamControl {...props} options={[gemini]} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Team presets' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Mixed team' }))
    fireEvent.click(screen.getByRole('button', { name: 'Load' }))
    fireEvent.change(screen.getByLabelText('What should the team do?'), {
      target: { value: 'Build parser' }
    })
    expect(screen.getByRole('alert').textContent).toContain('codex is unavailable on this host')
    expect(screen.getByRole('button', { name: 'Start team' }).hasAttribute('disabled')).toBe(true)
    view.rerender(<AgentTeamControl {...props} options={[gemini, codex, opencode]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start team' }))
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ configuration: mixed }))
    )
  })

  it('adds and removes worker profiles and requires a positive safe integer pace', async () => {
    render(<AgentTeamControl {...props} options={[gemini]} />)
    fireEvent.change(screen.getByLabelText('What should the team do?'), {
      target: { value: 'Review parser' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add worker profile' }))
    expect(screen.getByLabelText('When should the master use profile 2?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove worker profile 2' }))
    expect(screen.queryByLabelText('When should the master use profile 2?')).toBeNull()
    for (const invalid of ['0', '1.5', '9007199254740992']) {
      fireEvent.change(screen.getByLabelText('Approximate concurrency / pace'), {
        target: { value: invalid }
      })
      expect(screen.getByRole('button', { name: 'Start team' }).hasAttribute('disabled')).toBe(true)
    }
    fireEvent.change(screen.getByLabelText('Approximate concurrency / pace'), {
      target: { value: '32' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start team' }))
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({ configuration: expect.objectContaining({ parallelismHint: 32 }) })
      )
    )
  })
})
