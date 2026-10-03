import { useEffect, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import type { GroupWorker } from '@/lib/agent-group-launch'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { findFolderWorkspaceOwner } from '@/lib/folder-workspace-runtime-owner'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

const resultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  models: z.array(z.object({ id: z.string(), label: z.string() })).optional()
})
type Model = { id: string; label: string }
const pending = new Map<string, Promise<Model[]>>()
async function readModels(
  target: RuntimeClientTarget,
  worktreeId: string,
  agentId: string
): Promise<unknown> {
  const workspace = parseWorkspaceKey(worktreeId)
  if (target.kind === 'local' && workspace?.type === 'folder') {
    const state = useAppStore.getState()
    const owner = findFolderWorkspaceOwner(state, workspace.folderWorkspaceId)
    const folder = state.folderWorkspaces.find((entry) => entry === owner)
    const connectionId = getConnectionIdFromState(state, worktreeId)
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
function loadModels(
  target: RuntimeClientTarget,
  worktreeId: string,
  agent: string
): Promise<Model[]> {
  const key = JSON.stringify([target, worktreeId, agent])
  const existing = pending.get(key)
  if (existing) {
    return existing
  }
  const request = readModels(target, worktreeId, agent)
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

export function AgentGroupModel({
  worker,
  target,
  worktreeId,
  disabled,
  onChange,
  onApplyAll
}: {
  worker: GroupWorker
  target: RuntimeClientTarget
  worktreeId: string
  disabled: boolean
  onChange: (model: string) => void
  onApplyAll: () => void
}) {
  const supported = !!getAgentSessionOptionCatalog(worker.agent)?.supportsWorkerLaunchPreferences
  const [models, setModels] = useState<Model[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let stale = false
    setModels([])
    setError(null)
    if (!supported) {
      return
    }
    setLoading(true)
    void loadModels(target, worktreeId, worker.agent)
      .then((rows) => {
        if (!stale) {
          setModels(rows)
        }
      })
      .catch((reason: unknown) => {
        if (!stale) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
      .finally(() => {
        if (!stale) {
          setLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [supported, target, worktreeId, worker.agent, revision])
  if (!supported) {
    return (
      <p className="text-xs text-muted-foreground">
        {translate(
          'agentGroup.modelUnsupported',
          'This agent uses the model configured in its CLI.'
        )}
      </p>
    )
  }
  const id = `${worker.id}-model`
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{translate('agentGroup.model', 'Model')}</Label>
      {models.length > 0 ? (
        <Select value={worker.model ?? ''} disabled={disabled || loading} onValueChange={onChange}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue
              placeholder={translate('agentGroup.chooseModel', 'Choose a model before launching')}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {worker.model && !models.some((model) => model.id === worker.model) && (
                <SelectItem value={worker.model}>
                  {worker.model} ({translate('agentGroup.savedModel', 'saved; not listed')})
                </SelectItem>
              )}
              {models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          disabled={disabled || loading}
          value={worker.model ?? ''}
          onChange={(event) => onChange(event.target.value.trim())}
          placeholder={
            loading
              ? translate('agentGroup.loadingModels', 'Loading models from this host…')
              : translate('agentGroup.modelId', 'Enter an exact model ID')
          }
        />
      )}
      {error && (
        <p role="status" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled || loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          {translate('agentGroup.refreshModels', 'Refresh models')}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled || !worker.model}
          onClick={onApplyAll}
        >
          {translate('agentGroup.applyModel', 'Apply to all {{agent}} agents', {
            agent: worker.agent
          })}
        </Button>
      </div>
    </div>
  )
}
