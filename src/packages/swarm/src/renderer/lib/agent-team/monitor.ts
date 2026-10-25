import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import {
  teamSessionKey,
  emptyTeamSnapshot,
  type TeamSnapshot,
  type AgentTeamHost,
  type TeamSessionStore
} from './contracts'

type TeamMonitor = {
  snapshot: TeamSnapshot
  subscribers: Map<() => void, boolean>
  controller: AbortController
  refreshing: boolean
  timer?: ReturnType<typeof setInterval>
}

export function createTeamMonitor(host: AgentTeamHost, sessions: TeamSessionStore) {
  const panelMembershipByTeam = new Map<string, { runId: string; tabs: Set<string> }>()
  const monitors = new Map<string, TeamMonitor>()

  function publish(monitor: TeamMonitor, snapshot: TeamSnapshot) {
    monitor.snapshot = snapshot
    for (const listener of monitor.subscribers.keys()) {
      listener()
    }
  }

  async function refreshTeam(
    monitor: TeamMonitor,
    key: string,
    target: RuntimeClientTarget,
    worktreeId: string
  ) {
    const session = sessions.read(key)
    const isCurrent = () => {
      const saved = sessions.read(key)
      return (
        !monitor.controller.signal.aborted &&
        saved?.tabId === session?.tabId &&
        saved?.handle === session?.handle
      )
    }
    if (!isCurrent() || monitor.refreshing) {
      return
    }
    monitor.refreshing = true
    try {
      const snapshot = session
        ? await host.readSnapshot(target, worktreeId, session, monitor.controller.signal)
        : emptyTeamSnapshot
      if (!isCurrent()) {
        return
      }
      if (!snapshot.run) {
        panelMembershipByTeam.delete(key)
        publish(monitor, emptyTeamSnapshot)
        return
      }
      publish(monitor, snapshot)
      if ([...monitor.subscribers.values()].some(Boolean)) {
        let membership = panelMembershipByTeam.get(key)
        if (membership?.runId !== snapshot.run.id) {
          membership = { runId: snapshot.run.id, tabs: new Set<string>() }
          panelMembershipByTeam.set(key, membership)
        }
        await host.arrangePanels(
          target,
          snapshot,
          membership.tabs,
          monitor.controller.signal,
          () => isCurrent() && [...monitor.subscribers.values()].some(Boolean)
        )
      }
    } catch (reason) {
      if (isCurrent()) {
        publish(monitor, {
          ...monitor.snapshot,
          error: reason instanceof Error ? reason.message : String(reason)
        })
      }
    } finally {
      monitor.refreshing = false
    }
  }

  function subscribe(
    target: RuntimeClientTarget,
    worktreeId: string,
    listener: () => void,
    arrange = false
  ): () => void {
    const key = teamSessionKey(target, worktreeId)
    let monitor = monitors.get(key)
    if (!monitor) {
      monitor = {
        snapshot: emptyTeamSnapshot,
        subscribers: new Map(),
        controller: new AbortController(),
        refreshing: false
      }
      monitors.set(key, monitor)
    }
    const shared = monitor
    shared.subscribers.set(listener, arrange)
    if (shared.subscribers.size === 1) {
      void refreshTeam(shared, key, target, worktreeId)
      shared.timer = setInterval(() => void refreshTeam(shared, key, target, worktreeId), 5000)
    }
    return () => {
      shared.subscribers.delete(listener)
      if (shared.subscribers.size === 0) {
        clearInterval(shared.timer)
        shared.controller.abort()
        monitors.delete(key)
      }
    }
  }

  function getSnapshot(target: RuntimeClientTarget, worktreeId: string): TeamSnapshot {
    return monitors.get(teamSessionKey(target, worktreeId))?.snapshot ?? emptyTeamSnapshot
  }

  return { subscribe, getSnapshot }
}
