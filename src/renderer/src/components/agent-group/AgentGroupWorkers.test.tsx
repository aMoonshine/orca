// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { GroupWorker } from '@/lib/agent-group-launch'
import type { TabAgentLaunchOption } from '../tab-bar/tab-agent-launch-options'
vi.mock('./AgentGroupModel', () => ({ AgentGroupModel: () => null }))
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
})
