import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentTeamClient } from './client'
import {
  teamSessionKey,
  type AgentTeamHost,
  type TeamSession,
  type TeamSnapshot
} from './contracts'

const target = { kind: 'environment' as const, environmentId: 'remote-a' }
const worktreeId = 'folder:team'

function createClient(runId: string) {
  const saved = new Map<string, TeamSession>()
  const session = { tabId: `${runId}-master` }
  const snapshot: TeamSnapshot = {
    run: { id: runId, from: session.tabId, mode: 'solo', phaseId: 'work' },
    tasks: [],
    workers: [],
    error: null
  }
  const host = {
    launchMaster: vi.fn(() => session),
    resolveHandle: vi.fn(async () => session.tabId),
    bootstrap: vi.fn(async () => {}),
    readSnapshot: vi.fn<AgentTeamHost['readSnapshot']>(async () => snapshot),
    arrangePanels: vi.fn(async () => {}),
    openMaster: vi.fn(),
    openWorker: vi.fn(async () => {})
  } satisfies AgentTeamHost
  const client = createAgentTeamClient(host, {
    read: (key) => saved.get(key) ?? null,
    save: (key, value) => saved.set(key, value),
    detach: (key) => {
      saved.delete(key)
    }
  })
  return { client, host, saved, session, snapshot }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('agent team host interface', () => {
  it('starts, observes, opens and detaches a remote folder team without browser storage or Orca UI', async () => {
    const { client, host, session, snapshot } = createClient('remote-run')
    await client.start({
      target,
      worktreeId,
      objective: 'Review the parser',
      configuration: {
        leader: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
        profiles: [
          { id: 'review', agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', purpose: 'Review' }
        ],
        parallelismHint: 1
      }
    })
    expect(client.readSession(target, worktreeId)).toEqual(session)
    expect(host.bootstrap).toHaveBeenCalledWith(
      target,
      session.tabId,
      expect.stringContaining('Review the parser')
    )
    const updates: TeamSnapshot[] = []
    const unsubscribe = client.subscribe(
      target,
      worktreeId,
      () => {
        updates.push(client.getSnapshot(target, worktreeId))
      },
      true
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(updates).toEqual([snapshot])
    expect(host.readSnapshot).toHaveBeenCalledWith(
      target,
      worktreeId,
      session,
      expect.any(AbortSignal)
    )
    client.openMaster(target, worktreeId)
    expect(host.openMaster).toHaveBeenCalledWith(worktreeId, session)
    await client.openWorker(target, 'remote-worker')
    expect(host.openWorker).toHaveBeenCalledWith(target, 'remote-worker')
    client.detachSession(target, worktreeId)
    expect(client.readSession(target, worktreeId)).toBeNull()
    expect(() => client.openMaster(target, worktreeId)).toThrow('No saved master')
    await vi.advanceTimersByTimeAsync(5000)
    expect(client.getSnapshot(target, worktreeId).run).toBeNull()
    expect(host.readSnapshot).toHaveBeenCalledTimes(1)
    expect(host.arrangePanels).toHaveBeenCalledTimes(1)
    unsubscribe()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('isolates client instances and aborts only the instance whose final subscriber leaves', async () => {
    const first = createClient('first')
    const second = createClient('second')
    for (const entry of [first, second]) {
      entry.saved.set(teamSessionKey(target, worktreeId), entry.session)
    }
    const unsubscribeFirst = first.client.subscribe(target, worktreeId, () => {})
    const unsubscribeSecond = second.client.subscribe(target, worktreeId, () => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(first.client.getSnapshot(target, worktreeId).run?.id).toBe('first')
    expect(second.client.getSnapshot(target, worktreeId).run?.id).toBe('second')
    const firstSignal = first.host.readSnapshot.mock.calls[0][3]
    const secondSignal = second.host.readSnapshot.mock.calls[0][3]
    unsubscribeFirst()
    expect(firstSignal.aborted).toBe(true)
    expect(secondSignal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(first.host.readSnapshot).toHaveBeenCalledTimes(1)
    expect(second.host.readSnapshot).toHaveBeenCalledTimes(2)
    expect(first.client.getSnapshot(target, worktreeId).run).toBeNull()
    expect(second.client.readSession(target, worktreeId)).toEqual(second.session)
    unsubscribeSecond()
    expect(secondSignal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
