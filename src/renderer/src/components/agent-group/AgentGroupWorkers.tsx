import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { GroupWorker } from '@/lib/agent-group-launch'
import type { TabAgentLaunchOption } from '../tab-bar/tab-agent-launch-options'
import { AgentGroupModel } from './AgentGroupModel'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

export function AgentGroupWorkers({
  workers,
  target,
  worktreeId,
  options,
  writable,
  disabled,
  onChange
}: {
  workers: GroupWorker[]
  target: RuntimeClientTarget
  worktreeId: string
  options: TabAgentLaunchOption[]
  writable: boolean
  disabled: boolean
  onChange: (workers: GroupWorker[]) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      {workers.map((worker, index) => {
        const id = worker.id
        const change = (patch: Partial<GroupWorker>) =>
          onChange(workers.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))
        return (
          <fieldset key={id} disabled={disabled} className="flex min-w-0 flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">
              {translate('agentGroup.worker', 'Agent {{number}}', { number: index + 1 })}
            </legend>
            <Select
              value={worker.agent}
              disabled={disabled}
              onValueChange={(value) => {
                const option = options.find((entry) => entry.agent === value)
                if (option) {
                  change({ agent: option.agent, model: undefined })
                }
              }}
            >
              <SelectTrigger
                className="w-full"
                aria-label={translate('agentGroup.provider', 'Agent {{number}} provider', {
                  number: index + 1
                })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {options.map((option) => (
                    <SelectItem key={option.agent} value={option.agent}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <AgentGroupModel
              worker={worker}
              target={target}
              worktreeId={worktreeId}
              disabled={disabled}
              onChange={(model) => change({ model })}
              onApplyAll={() =>
                onChange(
                  workers.map((entry) =>
                    entry.agent === worker.agent ? { ...entry, model: worker.model } : entry
                  )
                )
              }
            />
            <Label htmlFor={id}>{translate('agentGroup.task', 'Task')}</Label>
            <Textarea
              id={id}
              value={worker.spec}
              onChange={(event) => change({ spec: event.target.value })}
              placeholder={translate(
                'agentGroup.taskPlaceholder',
                'Scope, expected result, and how to verify it'
              )}
            />
            {writable && (
              <>
                <Label htmlFor={`${id}-claims`}>
                  {translate('agentGroup.claims', 'Owned paths')}
                </Label>
                <Input
                  id={`${id}-claims`}
                  value={worker.claims}
                  onChange={(event) => change({ claims: event.target.value })}
                  placeholder="src/parser, src/parser.test.ts"
                />
              </>
            )}
          </fieldset>
        )
      })}
    </div>
  )
}
