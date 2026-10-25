import { z } from 'zod'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session-wire'
import { hasExplicitTuiLaunchCommand } from '../../../../../shared/tui-agent-launch-command-override'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { useAppStore } from '@/store'
import { getConnectionIdFromState } from '../../../../../renderer/src/lib/connection-context'
import { findFolderWorkspaceOwner } from '../../../../../renderer/src/lib/folder-workspace-runtime-owner'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import { getLocalProjectExecutionRuntimeContext } from '../../../../../renderer/src/lib/local-preflight-context'
import { parseWslUncPath } from '../../../../../shared/wsl-paths'
import { getEnvironmentRuntimeContextKey } from '../../../../../renderer/src/lib/provider-runtime-context'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
const resultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  models: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        efforts: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
        defaultEffort: z.string().optional(),
        effortsKnown: z.boolean().optional()
      })
    )
    .optional()
})
export type GroupModel = NonNullable<z.infer<typeof resultSchema>['models']>[number]
const pending = new Map<string, Promise<GroupModel[]>>()
export function agentGroupModelDiscoveryContextKey(
  target: RuntimeClientTarget,
  settings: Partial<GlobalSettings> | null
): string {
  return JSON.stringify([
    getEnvironmentRuntimeContextKey(target.kind === 'environment' ? target.environmentId : null),
    settings?.activeCodexManagedAccountId,
    settings?.activeCodexManagedAccountIdsByRuntime,
    settings?.codexManagedAccounts,
    target.kind === 'local'
      ? [settings?.agentCmdOverrides, settings?.agentDefaultArgs, settings?.agentDefaultEnv]
      : undefined
  ])
}
async function readModels(
  target: RuntimeClientTarget,
  worktreeId: string,
  agentId: string,
  forceRefresh: boolean
): Promise<unknown> {
  const state = useAppStore.getState()
  const connectionId = getConnectionIdFromState(state, worktreeId)
  const workspace = parseWorkspaceKey(worktreeId)
  const folderOwner =
    workspace?.type === 'folder'
      ? findFolderWorkspaceOwner(state, workspace.folderWorkspaceId)
      : null
  const folder = state.folderWorkspaces.find((entry) => entry === folderOwner)
  const execution =
    target.kind === 'local' ? getLocalProjectExecutionRuntimeContext(state, worktreeId) : undefined
  if (
    ['codex', 'opencode', 'opencode2'].includes(agentId) &&
    (target.kind === 'environment' ||
      (connectionId === null &&
        (!execution || (execution.status === 'resolved' && execution.runtime.kind !== 'wsl')) &&
        !(folder && parseWslUncPath(folder.folderPath)) &&
        (agentId !== 'codex' || !hasExplicitTuiLaunchCommand(state.settings, agentId))))
  ) {
    try {
      const params = { agent: agentId, worktree: `id:${worktreeId}` }
      const readCatalog = (refresh: boolean) =>
        callRuntimeRpc<AgentSessionModelCatalogResult>(
          target,
          'agentSession.modelCatalog',
          { ...params, ...(refresh ? { forceRefresh: true } : {}) },
          { timeoutMs: 90_000 }
        )
      let catalog: AgentSessionModelCatalogResult
      try {
        catalog = await readCatalog(forceRefresh)
      } catch (error) {
        if (
          !forceRefresh ||
          !(error instanceof RuntimeRpcCallError) ||
          error.code !== 'invalid_argument' ||
          !/^Unrecognized keys?: ["']forceRefresh["']$/.test(error.message)
        ) {
          throw error
        }
        catalog = await readCatalog(false)
      }
      if (catalog.listingInProgress) {
        catalog = await callRuntimeRpc<AgentSessionModelCatalogResult>(
          target,
          'agentSession.modelCatalog',
          { ...params, waitForListing: true },
          { timeoutMs: 90_000 }
        )
      }
      if (catalog.origin !== 'unknown') {
        return { success: true, models: catalog.models }
      }
    } catch (error) {
      if (
        !(error instanceof RuntimeRpcCallError) ||
        !['method_not_found', 'forbidden', 'structured_agent_session_unsupported'].includes(
          error.code
        )
      ) {
        throw error
      }
    }
  }
  if (target.kind === 'local' && workspace?.type === 'folder') {
    if (!folder || connectionId === undefined) {
      throw new Error('The workspace host is unavailable.')
    }
    return window.api.git.discoverCommitMessageModels({
      agentId,
      worktreePath: folder.folderPath,
      connectionId: connectionId ?? undefined
    })
  }
  return callRuntimeRpc(
    target,
    'git.discoverCommitMessageModels',
    { worktree: `id:${worktreeId}`, agentId },
    { timeoutMs: 75_000 }
  )
}
export function loadAgentGroupModels(
  target: RuntimeClientTarget,
  worktreeId: string,
  agent: string,
  options?: { forceRefresh?: boolean }
): Promise<GroupModel[]> {
  const settings = useAppStore.getState().settings
  const key = JSON.stringify([
    target,
    worktreeId,
    agent,
    agentGroupModelDiscoveryContextKey(target, settings),
    options?.forceRefresh === true
  ])
  const existing = pending.get(key)
  if (existing) {
    return existing
  }
  const request = readModels(target, worktreeId, agent, options?.forceRefresh === true)
    .then((raw) => {
      const result = resultSchema.parse(raw)
      if (!result.success) {
        throw new Error(result.error ?? 'Model discovery failed.')
      }
      return result.models ?? []
    })
    .finally(() => pending.delete(key))
  pending.set(key, request)
  return request
}
