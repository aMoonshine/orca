// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TabAgentLaunchOption } from '../tab-bar/tab-agent-launch-options'

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  launch: vi.fn(),
  snapshot: { run: null, tasks: [], receipts: [], error: null, busy: false }
}))
vi.mock('@/lib/agent-group-registry', () => ({
  getAgentGroupController: () => ({
    subscribe: () => () => {},
    getSnapshot: () => mocks.snapshot,
    refresh: mocks.refresh,
    launch: mocks.launch
  })
}))
vi.mock('./EngineeringWorkflow', () => ({ EngineeringWorkflow: () => null }))
vi.mock('./AgentTeamControl', () => ({ AgentTeamControl: () => null }))
vi.mock('./AgentGroupModel', () => ({ AgentGroupModel: () => null }))
import { AgentGroupDialog } from './AgentGroupDialog'

const props = { target: { kind: 'local' as const }, worktreeId: 'folder:test', onClose: vi.fn() }
const gemini: TabAgentLaunchOption = {
  agent: 'gemini',
  label: 'Gemini',
  aliases: [],
  row: { kind: 'cli', agent: 'gemini' }
}
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  mocks.launch.mockResolvedValue(undefined)
})
afterEach(cleanup)

describe('manual wave async inventory', () => {
  it('populates workers after inventory arrives, preserves entered tasks, and launches the eligible CLI', async () => {
    const view = render(<AgentGroupDialog {...props} options={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manual launch' }))
    expect(screen.getByRole('status').textContent).toContain('No enabled agents')
    view.rerender(<AgentGroupDialog {...props} options={[gemini]} />)
    await waitFor(() => expect(screen.getAllByLabelText('Task')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Group goal'), { target: { value: 'Review parser' } })
    const tasks = screen.getAllByLabelText('Task')
    fireEvent.change(tasks[0], { target: { value: 'Review syntax' } })
    fireEvent.change(tasks[1], { target: { value: 'Review types' } })
    view.rerender(
      <AgentGroupDialog
        {...props}
        options={[{ agent: 'codex', label: 'Codex', aliases: [] }, gemini]}
      />
    )
    const launch = screen.getByRole('button', { name: 'Launch 2 agents' })
    expect(launch.hasAttribute('disabled')).toBe(false)
    fireEvent.click(launch)
    await waitFor(() =>
      expect(mocks.launch).toHaveBeenCalledWith('folder:test', 'swarm', 'Review parser', [
        expect.objectContaining({ agent: 'gemini', spec: 'Review syntax' }),
        expect.objectContaining({ agent: 'gemini', spec: 'Review types' })
      ])
    )
  })
})
