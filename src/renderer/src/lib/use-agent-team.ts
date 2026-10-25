import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { getAgentTeamSnapshot, subscribeToAgentTeam } from './agent-team/monitor'

export function useAgentTeam(target: RuntimeClientTarget, worktreeId: string, arrange = false) {
  const environmentId = target.kind === 'environment' ? target.environmentId : undefined
  const runtimeTarget = useMemo<RuntimeClientTarget>(
    () =>
      environmentId === undefined ? { kind: 'local' } : { kind: 'environment', environmentId },
    [environmentId]
  )
  const subscribe = useCallback(
    (listener: () => void) => subscribeToAgentTeam(runtimeTarget, worktreeId, listener, arrange),
    [runtimeTarget, worktreeId, arrange]
  )
  const getSnapshot = useCallback(
    () => getAgentTeamSnapshot(runtimeTarget, worktreeId),
    [runtimeTarget, worktreeId]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
