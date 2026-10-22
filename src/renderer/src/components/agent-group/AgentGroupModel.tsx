import { useEffect, useMemo, useState } from 'react'
import {
  agentGroupModelDiscoveryContextKey,
  loadAgentGroupModels,
  type GroupModel
} from '@/lib/agent-group-model-discovery'
import { useAppStore } from '@/store'
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
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import { getAgentSessionOptionLaunchCatalog } from '../../../../shared/agent-session-option-launch'
import { checkAgentLaunchModelPreferences } from '../../../../shared/agent-launch-model-preferences'
import { agentSessionEffortLevels } from '../../../../shared/agent-session-effort-levels'
import type { GroupWorker } from '@/lib/agent-group-launch'
import { translate } from '@/i18n/i18n'

export function AgentGroupModel({
  worker,
  target,
  worktreeId,
  disabled,
  onChange,
  onApplyAll,
  onEffortChange
}: {
  worker: GroupWorker
  target: RuntimeClientTarget
  worktreeId: string
  disabled: boolean
  onChange: (model: string) => void
  onApplyAll?: () => void
  onEffortChange?: (effort: string | undefined) => void
}) {
  const supported = !!getAgentSessionOptionCatalog(worker.agent)?.supportsWorkerLaunchPreferences
  const [models, setModels] = useState<GroupModel[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const discoveryTarget = useMemo<RuntimeClientTarget>(
    () => (environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }),
    [environmentId]
  )
  const catalogContext = useAppStore((state) =>
    agentGroupModelDiscoveryContextKey(discoveryTarget, state.settings)
  )
  useEffect(() => {
    let stale = false
    setModels([])
    setError(null)
    if (!supported) {
      return
    }
    setLoading(true)
    void loadAgentGroupModels(discoveryTarget, worktreeId, worker.agent, {
      forceRefresh: revision > 0
    })
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
  }, [supported, discoveryTarget, worktreeId, worker.agent, revision, catalogContext])
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
  const model = models.find((entry) => entry.id === worker.model)
  const launchCatalog = getAgentSessionOptionLaunchCatalog(worker.agent)
  const catalogModel = launchCatalog?.models.find((entry) => entry.id === worker.model)
  const effortOption = (catalogModel?.options ?? launchCatalog?.unknownModelOptions)?.find(
    (option) => option.id === 'effort'
  )
  const hostLevels = agentSessionEffortLevels(
    model?.efforts !== undefined
      ? { efforts: model.efforts, ...(model.effortsKnown === false ? { effortsKnown: false } : {}) }
      : undefined
  )
  const effortChoices =
    effortOption?.kind.type === 'select' && effortOption.apply.launchArgs && worker.model
      ? (hostLevels === null ? effortOption.kind.choices : (model?.efforts ?? [])).filter(
          (choice) =>
            !(
              'refusal' in
              checkAgentLaunchModelPreferences({
                agent: worker.agent,
                model: worker.model,
                effort: choice.value,
                openCodeModelLaunchSupported: true
              })
            )
        )
      : []
  const supportsEffort = effortOption?.kind.type === 'select' && !!effortOption.apply.launchArgs
  const invalidEffort =
    !!worker.effort && !effortChoices.some((choice) => choice.value === worker.effort)
  const effortId = `${worker.id}-effort`
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
      {onEffortChange && supportsEffort && (effortChoices.length > 0 || worker.effort) && (
        <>
          <Label htmlFor={effortId}>{translate('agentGroup.effort', 'Reasoning effort')}</Label>
          <Select
            value={worker.effort ?? '__cli_default__'}
            disabled={disabled || loading}
            onValueChange={(value) =>
              onEffortChange(value === '__cli_default__' ? undefined : value)
            }
          >
            <SelectTrigger id={effortId} className="w-full" aria-invalid={invalidEffort}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="__cli_default__">
                  {translate('agentGroup.effortDefault', 'CLI default')}
                  {model?.defaultEffort ? ` (${model.defaultEffort})` : ''}
                </SelectItem>
                {invalidEffort && worker.effort && (
                  <SelectItem value={worker.effort} disabled>
                    {worker.effort} ({translate('agentGroup.effortUnavailable', 'unavailable')})
                  </SelectItem>
                )}
                {effortChoices.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {invalidEffort && (
            <p role="alert" className="text-xs text-destructive">
              {translate(
                'agentGroup.effortInvalid',
                'This effort is unavailable for the selected model. Choose another effort or CLI default.'
              )}
            </p>
          )}
        </>
      )}
      {worker.effort && !supportsEffort && (
        <p role="alert" className="text-xs text-destructive">
          {translate(
            'agentGroup.effortUnsupported',
            'This agent cannot launch with effort {{effort}}.',
            {
              effort: worker.effort
            }
          )}
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
        {onApplyAll && (
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
        )}
      </div>
    </div>
  )
}
