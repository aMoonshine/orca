import { createBrowserUuid } from '@/lib/browser-uuid'
import { getAgentGroupController } from '@/lib/agent-group-registry'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
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
import { groupPhaseWorkerLimit, type GroupWorker } from '@/lib/agent-group-launch'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  AGENT_WORK_MODES,
  firstPhaseFor,
  isAgentWorkMode,
  nextPhaseFor,
  phaseDefinition,
  MODE_PROTOCOLS,
  type AgentWorkMode
} from '../../../../shared/swarm/mode-protocols'
import type { TabAgentLaunchOption } from '../tab-bar/tab-agent-launch-options'
import { AgentGroupWorkers } from './AgentGroupWorkers'
import { AgentTeamControl } from './AgentTeamControl'
import { AgentGroupInbox } from './AgentGroupInbox'
import { EngineeringWorkflow } from './EngineeringWorkflow'
import { loadGroupDraft, saveGroupDraft } from '@/lib/agent-group-draft'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'

const MODE_COPY: Record<AgentWorkMode, string> = {
  solo: 'One agent carries out a task.',
  swarm: 'Agents coordinate, implement in a shared folder, then review incoming changes.',
  fusion: 'Independent reviews, a judge, then one integrator.',
  orchestrator: 'Plan first, implement in separate worktrees, then integrate.'
}

export function AgentGroupDialog({
  worktreeId,
  target,
  options,
  onClose
}: {
  worktreeId: string
  target: RuntimeClientTarget
  options: TabAgentLaunchOption[]
  onClose: () => void
}) {
  const controller = useMemo(
    () => getAgentGroupController(target, worktreeId),
    [target, worktreeId]
  )
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [manual, setManual] = useState(false)
  const draftKey = `orca.agent-group-draft.${JSON.stringify(target)}.${worktreeId}`
  const [draft] = useState(() => loadGroupDraft(draftKey))
  const [selectedMode, setMode] = useState<AgentWorkMode>(draft?.mode ?? 'swarm')
  const [objective, setObjective] = useState(draft?.objective ?? '')
  const [workers, setWorkers] = useState<GroupWorker[]>(
    () =>
      draft?.workers ??
      (options[0]
        ? [
            { id: createBrowserUuid(), agent: options[0].agent, spec: '', claims: '' },
            { id: createBrowserUuid(), agent: options[0].agent, spec: '', claims: '' }
          ]
        : [])
  )
  const mode = snapshot.run?.mode ?? selectedMode
  const phase = phaseDefinition(mode, snapshot.run?.phaseId ?? '') ?? firstPhaseFor(mode)
  const limit = groupPhaseWorkerLimit(mode, phase.id)
  const visibleWorkers = workers.slice(0, limit)
  const next = nextPhaseFor(mode, phase.id)
  const ready =
    objective.trim() &&
    visibleWorkers.length > 0 &&
    visibleWorkers.every(
      (worker) =>
        worker.spec.trim() &&
        options.some((option) => option.agent === worker.agent) &&
        (!getAgentSessionOptionCatalog(worker.agent)?.supportsWorkerLaunchPreferences ||
          worker.model?.trim()) &&
        (!phase.allowsFileClaims || mode === 'solo' || worker.claims.trim())
    )

  useEffect(() => {
    void controller.refresh()
  }, [controller])
  useEffect(() => {
    saveGroupDraft(draftKey, { mode: selectedMode, objective, workers })
  }, [draftKey, selectedMode, objective, workers])

  const setCount = (count: number) => {
    const first = workers[0]
    if (!first) {
      return
    }
    setWorkers(
      Array.from(
        { length: count },
        (_, index) => workers[index] ?? { ...first, id: createBrowserUuid(), claims: '' }
      )
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent
        className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-2xl"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{translate('agentGroup.title', 'Launch agents')}</DialogTitle>
          <DialogDescription>
            {translate(
              'agentGroup.description',
              'Give one goal to a master agent, or configure a manual wave.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="scrollbar-sleek flex min-h-0 flex-col gap-4 overflow-y-auto pr-1 *:shrink-0">
          <div className="flex gap-2">
            <Button variant={manual ? 'outline' : 'default'} onClick={() => setManual(false)}>
              {translate('agentTeam.masterChat', 'Master chat')}
            </Button>
            <Button variant={manual ? 'default' : 'outline'} onClick={() => setManual(true)}>
              {translate('agentTeam.manual', 'Manual launch')}
            </Button>
          </div>
          {!manual ? (
            <AgentTeamControl
              target={target}
              worktreeId={worktreeId}
              options={options}
              onClose={onClose}
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-group-mode">
                    {translate('agentGroup.mode', 'Work mode')}
                  </Label>
                  <Select
                    value={mode}
                    disabled={snapshot.busy || !!snapshot.run}
                    onValueChange={(value) => {
                      if (isAgentWorkMode(value)) {
                        setMode(value)
                      }
                    }}
                  >
                    <SelectTrigger id="agent-group-mode" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {AGENT_WORK_MODES.map((entry) => (
                          <SelectItem key={entry} value={entry}>
                            {MODE_PROTOCOLS[entry].label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-group-count">
                    {translate('agentGroup.count', 'Agents in this wave')}
                  </Label>
                  <Select
                    value={String(visibleWorkers.length)}
                    disabled={snapshot.busy || limit === 1 || options.length === 0}
                    onValueChange={(value) => setCount(Number(value))}
                  >
                    <SelectTrigger id="agent-group-count" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {Array.from({ length: limit }, (_, index) => (
                          <SelectItem key={index + 1} value={String(index + 1)}>
                            {index + 1}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {translate(`agentGroup.mode.${mode}`, MODE_COPY[mode])}
              </p>
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">
                  {translate('agentGroup.phase', 'Phase: {{phase}}', { phase: phase.label })}
                </p>
                <p className="text-xs text-muted-foreground">{phase.instruction}</p>
                {!phase.allowsFileClaims && (
                  <p className="text-xs text-muted-foreground">
                    {translate(
                      'agentGroup.readonly',
                      'Agents are instructed to read only. File claims are blocked; filesystem writes are not sandboxed.'
                    )}
                  </p>
                )}
              </div>
              {options.length === 0 ? (
                <p role="status">
                  {translate(
                    'agentGroup.noAgents',
                    'No enabled agents detected on this host. Configure an agent in Settings first.'
                  )}
                </p>
              ) : (
                <>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="agent-group-objective">
                      {translate('agentGroup.goal', 'Group goal')}
                    </Label>
                    <Textarea
                      id="agent-group-objective"
                      disabled={snapshot.busy}
                      value={objective}
                      onChange={(event) => setObjective(event.target.value)}
                      placeholder={translate(
                        'agentGroup.goalPlaceholder',
                        'What should this group accomplish?'
                      )}
                    />
                  </div>
                  <EngineeringWorkflow
                    worktreeId={worktreeId}
                    objective={objective}
                    options={options}
                    disabled={snapshot.busy}
                    onClose={onClose}
                  />
                  <AgentGroupWorkers
                    target={target}
                    worktreeId={worktreeId}
                    workers={visibleWorkers}
                    options={options}
                    writable={phase.allowsFileClaims}
                    disabled={snapshot.busy}
                    onChange={setWorkers}
                  />
                </>
              )}
              {snapshot.run && (
                <p className="break-all text-xs text-muted-foreground">
                  {snapshot.run.id} · {snapshot.run.from}
                </p>
              )}
              {snapshot.receipts.map((receipt, index) => (
                <p
                  key={receipt.dispatchId ?? receipt.taskId ?? receipt.state}
                  className="break-words text-xs"
                  role="status"
                >
                  {index + 1}. {receipt.state} · {receipt.dispatchId ?? receipt.lastError}
                  {receipt.failedStage && ` · ${receipt.failedStage}`}
                  {receipt.lastError && receipt.dispatchId && `: ${receipt.lastError}`}
                </p>
              ))}
              {snapshot.tasks.map((task) => (
                <details key={task.id} className="text-xs">
                  <summary className="cursor-pointer">
                    {task.status} · {task.id}
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap break-words">{task.result ?? task.spec}</p>
                </details>
              ))}
              {snapshot.run && (
                <AgentGroupInbox key={snapshot.run.id} run={snapshot.run} target={target} />
              )}
              {snapshot.error && (
                <p role="alert" className="text-sm text-destructive">
                  {snapshot.error}
                </p>
              )}
            </>
          )}
        </div>
        {manual && (
          <DialogFooter>
            {snapshot.run && (
              <Button variant="ghost" disabled={snapshot.busy} onClick={controller.newGroup}>
                {translate('agentGroup.new', 'New group')}
              </Button>
            )}
            {snapshot.run && (
              <Button
                variant="outline"
                disabled={snapshot.busy}
                onClick={() => void controller.refresh()}
              >
                {translate('agentGroup.refresh', 'Refresh')}
              </Button>
            )}
            {snapshot.run && next && (
              <Button
                variant="outline"
                disabled={snapshot.busy}
                onClick={() => void controller.advance()}
              >
                {translate('agentGroup.advance', 'Advance to {{phase}}', { phase: next.label })}
              </Button>
            )}
            <Button
              disabled={snapshot.busy || !ready}
              onClick={() =>
                void controller.launch(worktreeId, mode, objective, visibleWorkers).then(() => {
                  if (!controller.getSnapshot().error) {
                    onClose()
                  }
                })
              }
            >
              {snapshot.busy && <Loader2 className="animate-spin" />}
              {snapshot.busy
                ? translate('agentGroup.starting', 'Checking and launching…')
                : translate('agentGroup.launch', 'Launch {{count}} agents', {
                    count: visibleWorkers.length
                  })}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
