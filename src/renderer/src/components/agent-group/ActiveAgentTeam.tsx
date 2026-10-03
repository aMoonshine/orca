import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'
import { useAgentTeam } from '@/lib/use-agent-team'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { AgentTeamBoard } from './AgentTeamBoard'

function Monitor({ target, worktreeId }: { target: RuntimeClientTarget; worktreeId: string }) {
  useAgentTeam(target, worktreeId, true)
  return null
}

export function ActiveAgentTeam({ board = false }: { board?: boolean }) {
  const { worktreeId, environmentId, available } = useAppStore(
    useShallow((state) => {
      const worktreeId = state.activeWorktreeId
      const route = worktreeId ? resolveWorktreeOperationRouteResult(state, worktreeId) : null
      return {
        worktreeId,
        available: route?.kind === 'resolved',
        environmentId: route?.kind === 'resolved' ? route.route.runtimeEnvironmentId : undefined
      }
    })
  )
  const target = useMemo<RuntimeClientTarget>(
    () => (environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }),
    [environmentId]
  )
  if (!worktreeId || !available) {
    return null
  }
  return board ? (
    <AgentTeamBoard key={worktreeId} target={target} worktreeId={worktreeId} />
  ) : (
    <Monitor key={worktreeId} target={target} worktreeId={worktreeId} />
  )
}
