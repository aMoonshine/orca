// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TabAgentLaunchOption } from '../tab-bar/tab-agent-launch-options'

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
const props = { target: { kind: 'local' as const }, worktreeId: 'folder:test', onClose: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
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
    await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(2))
    const start = screen.getByRole('button', { name: 'Start team' })
    expect(start.hasAttribute('disabled')).toBe(false)
    fireEvent.click(start)
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({
          leader: 'gemini',
          leaderModel: '',
          agent: 'gemini',
          model: '',
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
          leader: 'codex',
          leaderModel: 'exact/master',
          agent: 'codex',
          model: 'exact/worker'
        })
      )
    )
  })
})
