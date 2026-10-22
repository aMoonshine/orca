// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { GroupWorker } from '@/lib/agent-group-launch'
import type { TabAgentLaunchOption } from '../tab-bar/tab-agent-launch-options'
vi.mock('./AgentGroupModel', () => ({
  AgentGroupModel: ({
    worker,
    onChange,
    onEffortChange,
    onApplyAll
  }: {
    worker: GroupWorker
    onChange: (model: string) => void
    onEffortChange: (effort: string | undefined) => void
    onApplyAll: () => void
  }) => (
    <>
      <button onClick={() => onChange('gpt-6.1-sol')}>Model {worker.id}</button>
      <button onClick={() => onEffortChange('high')}>Effort {worker.id}</button>
      <button onClick={() => onEffortChange(undefined)}>Default {worker.id}</button>
      <button onClick={onApplyAll}>Apply {worker.id}</button>
    </>
  )
}))
import { AgentGroupWorkers } from './AgentGroupWorkers'

afterEach(cleanup)
const options: TabAgentLaunchOption[] = [
  {
    agent: 'gemini',
    label: 'Gemini Chat',
    aliases: [],
    id: 'chat:gemini',
    disabled: true,
    reason: 'Chat unavailable',
    row: { kind: 'chat-unavailable', agent: 'gemini', reason: 'not-on-host' }
  },
  {
    agent: 'gemini',
    label: 'Gemini CLI',
    aliases: [],
    id: 'cli:gemini',
    row: { kind: 'cli', agent: 'gemini' }
  },
  {
    agent: 'codex',
    label: 'Codex Chat',
    aliases: [],
    id: 'chat:codex',
    row: { kind: 'chat-unavailable', agent: 'codex', reason: 'not-installed' },
    reason: 'Not installed'
  }
]

function Workers() {
  const [workers, setWorkers] = useState<GroupWorker[]>([
    { id: 'worker', agent: 'gemini', spec: 'Keep task', claims: '' }
  ])
  return (
    <AgentGroupWorkers
      target={{ kind: 'local' }}
      worktreeId="folder:test"
      workers={workers}
      options={options}
      disabled={false}
      writable={false}
      onChange={setWorkers}
    />
  )
}

describe('group provider selection', () => {
  it('collapses unavailable Chat and runnable CLI into one eligible provider and disables unavailable providers', () => {
    render(<Workers />)
    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toContain('Gemini CLI')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const rows = screen.getAllByRole('option')
    expect(rows).toHaveLength(2)
    expect(
      rows.find((row) => row.textContent?.includes('Gemini CLI'))?.getAttribute('aria-disabled')
    ).not.toBe('true')
    expect(
      rows.find((row) => row.textContent?.includes('Codex'))?.getAttribute('aria-disabled')
    ).toBe('true')
    expect(screen.getByLabelText('Task').getAttribute('id')).toBe('worker')
  })

  const workers: GroupWorker[] = [
    {
      id: 'first',
      agent: 'codex',
      model: 'opaque/codex',
      effort: 'high',
      spec: 'Keep task',
      claims: 'src/a'
    },
    {
      id: 'second',
      agent: 'codex',
      model: 'older',
      effort: 'low',
      spec: 'Other task',
      claims: 'src/b'
    },
    { id: 'third', agent: 'opencode', model: 'opencode/free', spec: '', claims: '' }
  ]
  const availableOptions: TabAgentLaunchOption[] = [
    {
      id: 'cli:codex',
      agent: 'codex',
      label: 'Codex CLI',
      aliases: [],
      row: { kind: 'cli', agent: 'codex' }
    },
    {
      id: 'cli:opencode',
      agent: 'opencode',
      label: 'OpenCode CLI',
      aliases: [],
      row: { kind: 'cli', agent: 'opencode' }
    }
  ]

  function renderWorkers(initialWorkers = workers) {
    const onChange = vi.fn()
    render(
      <AgentGroupWorkers
        workers={initialWorkers}
        target={{ kind: 'local' }}
        worktreeId="folder:test"
        options={availableOptions}
        writable={false}
        disabled={false}
        onChange={onChange}
      />
    )
    return onChange
  }

  it('clears effort when the user changes provider', () => {
    const onChange = renderWorkers()
    fireEvent.keyDown(screen.getAllByRole('combobox')[0], { key: 'ArrowDown' })
    fireEvent.click(screen.getByRole('option', { name: 'OpenCode CLI' }))
    expect(onChange).toHaveBeenCalledWith([
      { ...workers[0], agent: 'opencode', model: undefined, effort: undefined },
      workers[1],
      workers[2]
    ])
  })

  it('clears effort when the user changes model', () => {
    const onChange = renderWorkers()
    fireEvent.click(screen.getByRole('button', { name: 'Model first' }))
    expect(onChange).toHaveBeenCalledWith([
      { ...workers[0], model: 'gpt-6.1-sol', effort: undefined },
      workers[1],
      workers[2]
    ])
  })

  it('forwards an effort override and CLI default without changing the model', () => {
    const onChange = renderWorkers()
    fireEvent.click(screen.getByRole('button', { name: 'Effort second' }))
    expect(onChange).toHaveBeenLastCalledWith([
      workers[0],
      { ...workers[1], effort: 'high' },
      workers[2]
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Default second' }))
    expect(onChange).toHaveBeenLastCalledWith([
      workers[0],
      { ...workers[1], effort: undefined },
      workers[2]
    ])
  })

  it.each(['high', undefined])(
    'applies model and effort %s only to matching providers',
    (effort) => {
      const source = { ...workers[0], effort }
      const onChange = renderWorkers([source, workers[1], workers[2]])
      fireEvent.click(screen.getByRole('button', { name: 'Apply first' }))
      expect(onChange).toHaveBeenCalledWith([
        source,
        { ...workers[1], model: source.model, effort },
        workers[2]
      ])
    }
  )
})
