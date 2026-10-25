import { useId, useState } from 'react'
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
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  readAgentTeamPresets,
  writeAgentTeamPresets,
  type AgentTeamPreset
} from '../lib/agent-team-presets'
import {
  agentTeamConfigurationSchema,
  type AgentTeamConfiguration
} from '../../shared/agent-team-configuration'

type AgentTeamPresetsProps = {
  storageKey: string
  configuration: AgentTeamConfiguration | null
  disabled: boolean
  onLoad: (configuration: AgentTeamConfiguration) => void
}

export function AgentTeamPresets(props: AgentTeamPresetsProps) {
  return <ScopedAgentTeamPresets key={props.storageKey} {...props} />
}

function ScopedAgentTeamPresets({
  storageKey,
  configuration,
  disabled,
  onLoad
}: AgentTeamPresetsProps) {
  const id = useId()
  const [presets, setPresets] = useState(() => readAgentTeamPresets(storageKey))
  const [selectedId, setSelectedId] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const selected = presets.find((preset) => preset.id === selectedId)
  const trimmedName = name.trim()
  const duplicateName = presets.some(
    (preset) => preset.name.toLowerCase() === trimmedName.toLowerCase()
  )

  function persist(next: AgentTeamPreset[]): boolean {
    try {
      writeAgentTeamPresets(storageKey, next)
      setPresets(next)
      setError(null)
      return true
    } catch {
      setError(
        translate(
          'agentTeam.presets.writeFailed',
          'Could not save presets. Check browser storage and try again.'
        )
      )
      return false
    }
  }

  function saveAs() {
    if (disabled || !configuration || !trimmedName || duplicateName) {
      return
    }
    const preset: AgentTeamPreset = {
      id: createBrowserUuid(),
      name: trimmedName,
      configuration: agentTeamConfigurationSchema.parse(configuration)
    }
    if (persist([...presets, preset])) {
      setSelectedId(preset.id)
      setName('')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-preset`}>
          {translate('agentTeam.presets.label', 'Team presets')}
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={selectedId}
            disabled={disabled || presets.length === 0}
            onValueChange={setSelectedId}
          >
            <SelectTrigger id={`${id}-preset`} className="min-w-0 flex-1">
              <SelectValue placeholder={translate('agentTeam.presets.choose', 'Choose a preset')} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {presets.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {preset.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || !selected}
            onClick={() => {
              if (!disabled && selected) {
                onLoad(agentTeamConfigurationSchema.parse(selected.configuration))
              }
            }}
          >
            {translate('agentTeam.presets.load', 'Load')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled || !selected}
            onClick={() => {
              if (
                !disabled &&
                selected &&
                persist(presets.filter((preset) => preset.id !== selected.id))
              ) {
                setSelectedId('')
              }
            }}
          >
            {translate('agentTeam.presets.delete', 'Delete')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'agentTeam.presets.scope',
            'Saved for this host and workspace. Models are checked again before launch.'
          )}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-name`}>{translate('agentTeam.presets.name', 'Preset name')}</Label>
        <div className="flex items-center gap-2">
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={80}
            disabled={disabled || !configuration}
            aria-invalid={duplicateName}
            aria-describedby={duplicateName ? `${id}-duplicate` : undefined}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                saveAs()
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || !configuration || !trimmedName || duplicateName}
            onClick={saveAs}
          >
            {translate('agentTeam.presets.saveAs', 'Save as')}
          </Button>
        </div>
        {duplicateName && (
          <p id={`${id}-duplicate`} className="text-xs text-destructive">
            {translate('agentTeam.presets.duplicate', 'Choose a different preset name.')}
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
