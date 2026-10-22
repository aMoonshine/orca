// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupRun } from '@/lib/agent-group-launch'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
import { AgentGroupInbox } from './AgentGroupInbox'

const run: GroupRun = { id: 'run-a', from: 'master-a', mode: 'swarm', phaseId: 'implementation' }
const target = { kind: 'local' } as const
const question = { id: 'question', type: 'question', subject: 'Proceed?', body: 'Choose a path' }
const inbox = { messages: [question], pendingQuestions: [question] }

beforeEach(() => {
  vi.useFakeTimers()
  mocks.rpc.mockReset().mockResolvedValue(inbox)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('AgentGroupInbox identity and request isolation', () => {
  it.each([
    { nextRun: { ...run, id: 'run-b' }, nextTarget: target },
    { nextRun: { ...run, from: 'master-b' }, nextTarget: target },
    { nextRun: run, nextTarget: { kind: 'environment', environmentId: 'remote' } }
  ] satisfies { nextRun: GroupRun; nextTarget: RuntimeClientTarget }[])(
    'drops an old refresh after switching to $nextRun.id / $nextTarget.kind',
    async ({ nextRun, nextTarget }) => {
      const old = Promise.withResolvers<unknown>()
      mocks.rpc.mockReturnValueOnce(old.promise)
      const view = render(<AgentGroupInbox run={run} target={target} />)
      const signal: AbortSignal = mocks.rpc.mock.calls[0][3].signal
      view.rerender(<AgentGroupInbox run={nextRun} target={nextTarget} />)
      await act(async () => {})
      expect(signal.aborted).toBe(true)
      expect(screen.getByText('Choose a path')).toBeTruthy()
      await act(async () => {
        old.resolve({ messages: [{ ...question, body: 'stale question' }] })
      })
      expect(screen.queryByText('stale question')).toBeNull()
      expect(screen.getByText('Choose a path')).toBeTruthy()
      expect(mocks.rpc).toHaveBeenCalledTimes(2)
    }
  )

  it('ignores an old error and prevents overlapping polls or manual refreshes', async () => {
    const old = Promise.withResolvers<unknown>()
    mocks.rpc.mockReturnValueOnce(old.promise)
    const view = render(<AgentGroupInbox run={run} target={target} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh messages' }))
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    view.rerender(<AgentGroupInbox run={{ ...run, id: 'run-b' }} target={target} />)
    await act(async () => old.reject(new Error('old host unavailable')))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Refresh messages' }).hasAttribute('disabled')).toBe(
      false
    )
  })

  it.each(['success', 'failure'])(
    'fences late reply %s without clearing or unlocking the new reply',
    async (outcome) => {
      const old = Promise.withResolvers<unknown>()
      const current = Promise.withResolvers<unknown>()
      const view = render(<AgentGroupInbox run={run} target={target} />)
      await act(async () => {})
      fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
      fireEvent.change(screen.getByLabelText('Answer to selected question'), {
        target: { value: 'old draft' }
      })
      mocks.rpc.mockReturnValueOnce(old.promise)
      fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
      fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
      expect(mocks.rpc.mock.calls.filter((call) => call[1] === 'orchestration.reply')).toHaveLength(
        1
      )
      const oldSignal: AbortSignal = mocks.rpc.mock.calls[1][3].signal
      view.rerender(<AgentGroupInbox run={{ ...run, id: 'run-b' }} target={target} />)
      await act(async () => {})
      expect(oldSignal.aborted).toBe(true)
      expect(screen.queryByLabelText('Answer to selected question')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
      const input = screen.getByLabelText('Answer to selected question')
      expect(screen.queryByDisplayValue('old draft')).toBeNull()
      fireEvent.change(input, { target: { value: 'new draft' } })
      mocks.rpc.mockReturnValueOnce(current.promise)
      fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
      await act(async () => {
        if (outcome === 'success') {
          old.resolve({})
        } else {
          old.reject(new Error('old reply failed'))
        }
      })
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getByRole('button', { name: 'Send reply' }).hasAttribute('disabled')).toBe(true)
      expect(screen.getByDisplayValue('new draft')).toBeTruthy()
      expect(mocks.rpc).toHaveBeenCalledTimes(4)
      await act(async () => current.resolve({}))
      expect(screen.queryByLabelText('Answer to selected question')).toBeNull()
      expect(mocks.rpc).toHaveBeenCalledTimes(5)
    }
  )

  it('keeps pending asks alongside bounded history and offers replies only for open questions', async () => {
    const history = Array.from({ length: 100 }, (_, index) => ({
      id: `heartbeat-${index}`,
      type: 'heartbeat',
      subject: 'alive',
      body: `${index}`
    }))
    mocks.rpc.mockResolvedValueOnce({
      messages: [...history, { ...question, id: 'answered', body: 'already answered' }],
      pendingQuestions: [question]
    })
    render(<AgentGroupInbox run={run} target={target} />)
    await act(async () => {})
    expect(screen.getByText('Choose a path')).toBeTruthy()
    expect(screen.getByText('already answered')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Reply' })).toHaveLength(1)
    expect(mocks.rpc.mock.calls[0][2]).toEqual({ run: run.id, terminal: run.from, all: true })
  })

  it('supports older hosts without pendingQuestions and deduplicates pending history rows', async () => {
    mocks.rpc.mockResolvedValueOnce({ messages: [question] })
    render(<AgentGroupInbox run={run} target={target} />)
    await act(async () => {})
    expect(screen.getAllByText('Choose a path')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Reply' })).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.getAllByText('Choose a path')).toHaveLength(1)
  })
})
