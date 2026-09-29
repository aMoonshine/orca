import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { translate } from '@/i18n/i18n'
import {
  buildEngineeringPrompt,
  ENGINEERING_WORKFLOWS
} from '../../../../shared/engineering-workflow'
import type { TabAgentLaunchOption } from '../tab-bar/tab-agent-launch-options'

export function EngineeringWorkflow({
  worktreeId,
  objective,
  options,
  disabled,
  onClose
}: {
  worktreeId: string
  objective: string
  options: TabAgentLaunchOption[]
  disabled: boolean
  onClose: () => void
}) {
  const [workflow, setWorkflow] = useState('grill-with-docs')
  const [agent, setAgent] = useState(options[0]?.agent)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = ENGINEERING_WORKFLOWS.find((entry) => entry.name === workflow)
  const start = async () => {
    if (busy || !agent) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = launchAgentInNewTab({
        agent,
        worktreeId,
        prompt: buildEngineeringPrompt(workflow, objective),
        promptDelivery: 'submit-after-ready'
      })
      if (!result) {
        throw new Error('The agent could not be opened. Check the workspace connection.')
      }
      const settlement = await result.structuredSettlement
      if (settlement?.kind === 'failed') {
        throw new Error(String(settlement.error))
      }
      if (settlement?.kind === 'cancelled' || settlement?.kind === 'visibility-unknown') {
        throw new Error('Open the new agent tab to check its state before retrying.')
      }
      const delivery = await (settlement?.kind === 'structured'
        ? (settlement.promptDeliveryResult ?? result.promptDeliveryResult)
        : result.promptDeliveryResult)
      if (delivery && !delivery.delivered) {
        throw new Error(
          'Prompt delivery was not confirmed. Check the new agent tab before retrying.'
        )
      }
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="rounded-md border p-3" open>
      <summary className="cursor-pointer text-sm font-medium">
        {translate('agentGroup.engineering', 'Discuss and plan with an agent')}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          {translate(
            'agentGroup.interview',
            'Start with an interview: one question at a time, decisions saved in project documents. Approve the plan before implementation.'
          )}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="engineering-workflow">
              {translate('agentGroup.workflow', 'Engineering skill')}
            </Label>
            <Select value={workflow} onValueChange={setWorkflow} disabled={busy || disabled}>
              <SelectTrigger id="engineering-workflow" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {ENGINEERING_WORKFLOWS.map((entry) => (
                    <SelectItem key={entry.name} value={entry.name}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="engineering-agent">
              {translate('agentGroup.discussionAgent', 'Discussion agent')}
            </Label>
            <Select
              value={agent}
              onValueChange={(value) =>
                setAgent(options.find((entry) => entry.agent === value)?.agent ?? agent)
              }
              disabled={busy || disabled}
            >
              <SelectTrigger id="engineering-agent" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {options.map((entry) => (
                    <SelectItem key={entry.agent} value={entry.agent}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{selected?.description}</p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <Button
          variant="outline"
          disabled={
            busy || disabled || !objective.trim() || !options.some((entry) => entry.agent === agent)
          }
          onClick={() => void start()}
        >
          {busy
            ? translate('agentGroup.opening', 'Opening agent…')
            : workflow === 'grill-with-docs'
              ? translate('agentGroup.discuss', 'Discuss before implementation')
              : translate('agentGroup.startWorkflow', 'Start selected workflow')}
        </Button>
      </div>
    </details>
  )
}
