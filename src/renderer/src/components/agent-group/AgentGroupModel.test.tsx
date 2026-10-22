// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GroupModel } from '@/lib/agent-group-model-discovery'
import type { GroupWorker } from '@/lib/agent-group-launch'

const mocks = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: () => 'context' }))
vi.mock('@/lib/agent-group-model-discovery', () => ({
  agentGroupModelDiscoveryContextKey: () => 'context',
  loadAgentGroupModels: mocks.load
}))
import { AgentGroupModel } from './AgentGroupModel'

const worker: GroupWorker = {
  id: 'worker',
  agent: 'codex',
  model: 'gpt-6.1-sol',
  spec: '',
  claims: ''
}
const liveModel: GroupModel = {
  id: 'gpt-6.1-sol',
  label: 'Host Sol',
  defaultEffort: 'high',
  efforts: [{ value: 'high', label: 'Host high' }]
}
const props = {
  worker,
  target: { kind: 'local' } as const,
  worktreeId: 'folder:plain',
  disabled: false,
  onChange: vi.fn(),
  onApplyAll: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.load.mockResolvedValue([liveModel])
})
afterEach(cleanup)

async function openEffort() {
  const trigger = await screen.findByLabelText('Reasoning effort')
  await waitFor(() => expect(trigger.hasAttribute('disabled')).toBe(false))
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
}

describe('group model effort', () => {
  it('uses live choices for an exact opaque Codex model and forwards high', async () => {
    const onEffortChange = vi.fn()
    render(<AgentGroupModel {...props} onEffortChange={onEffortChange} />)
    await openEffort()
    expect(screen.getByRole('option', { name: 'CLI default (high)' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Ultra' })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'Host high' }))
    expect(onEffortChange).toHaveBeenCalledWith('high')
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('omits the override when CLI default is selected', async () => {
    const onEffortChange = vi.fn()
    render(
      <AgentGroupModel
        {...props}
        worker={{ ...worker, effort: 'high' }}
        onEffortChange={onEffortChange}
      />
    )
    await openEffort()
    fireEvent.click(screen.getByRole('option', { name: 'CLI default (high)' }))
    expect(onEffortChange).toHaveBeenCalledWith(undefined)
  })

  it('preserves a stale explicit effort after refresh and labels it invalid', async () => {
    const onEffortChange = vi.fn()
    render(
      <AgentGroupModel
        {...props}
        worker={{ ...worker, effort: 'high' }}
        onEffortChange={onEffortChange}
      />
    )
    await waitFor(() =>
      expect(screen.getByLabelText('Reasoning effort').textContent).toContain('Host high')
    )
    mocks.load.mockResolvedValue([{ ...liveModel, efforts: [] }])
    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }))
    await waitFor(() =>
      expect(screen.getByLabelText('Reasoning effort').getAttribute('aria-invalid')).toBe('true')
    )
    expect(screen.getByLabelText('Reasoning effort').textContent).toContain('high (unavailable)')
    expect(screen.getByRole('alert').textContent).toContain('Choose another effort or CLI default')
    expect(onEffortChange).not.toHaveBeenCalled()
    expect(props.onChange).not.toHaveBeenCalled()
    expect(mocks.load).toHaveBeenLastCalledWith(props.target, props.worktreeId, 'codex', {
      forceRefresh: true
    })
  })

  it.each([
    { id: worker.model, label: 'Old host' },
    { ...liveModel, effortsKnown: false, efforts: [] }
  ])('falls back to shared launch choices for unknown host effort metadata: %j', async (model) => {
    mocks.load.mockResolvedValue([model])
    render(<AgentGroupModel {...props} onEffortChange={vi.fn()} />)
    await openEffort()
    expect(screen.getByRole('option', { name: 'High' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Ultra' })).toBeTruthy()
  })

  it('respects an explicit empty effort catalog', async () => {
    mocks.load.mockResolvedValue([{ ...liveModel, efforts: [] }])
    render(<AgentGroupModel {...props} onEffortChange={vi.fn()} />)
    await screen.findByText('Host Sol')
    expect(screen.queryByLabelText('Reasoning effort')).toBeNull()
  })

  it('does not offer OpenCode variants as launch efforts, including saved invalid effort', async () => {
    mocks.load.mockResolvedValue([{ ...liveModel, id: 'opencode/free' }])
    render(
      <AgentGroupModel
        {...props}
        worker={{ ...worker, agent: 'opencode', model: 'opencode/free', effort: 'high' }}
        onEffortChange={vi.fn()}
      />
    )
    await screen.findByText('Host Sol')
    expect(screen.queryByLabelText('Reasoning effort')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('cannot launch with effort high')
  })

  it('keeps existing callers without an effort callback compatible', async () => {
    render(<AgentGroupModel {...props} />)
    await screen.findByText('Host Sol')
    expect(screen.queryByLabelText('Reasoning effort')).toBeNull()
  })
})
