import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { startAgentTeam } from '@/lib/agent-team/session'
import { readTeamSession, detachTeamSession, teamSessionKey } from '@/lib/agent-team/session-state'
import { openMasterSession } from '@/lib/agent-team/runtime'
import type { GroupWorker } from '@/lib/agent-group-launch'
import type { TabAgentLaunchOption } from '../tab-bar/tab-agent-launch-options'
import { AgentGroupWorkers } from './AgentGroupWorkers'
import { AgentTeamBoard } from './AgentTeamBoard'
import { groupProviderOptions, groupWorkerCanLaunch } from '@/lib/agent-group-provider-options'
import {
  agentTeamConfigurationSchema,
  type AgentTeamConfiguration
} from '../../../../shared/agent-team-configuration'
import { AgentTeamPresets } from './AgentTeamPresets'
import { agentTeamPresetKey } from '@/lib/agent-team-presets'
import { createBrowserUuid } from '@/lib/browser-uuid'

type AgentTeamControlProps = {
  target: RuntimeClientTarget
  worktreeId: string
  options: TabAgentLaunchOption[]
  onClose: () => void
}

export function AgentTeamControl(props: AgentTeamControlProps) {
  return <AgentTeamControlForm key={teamSessionKey(props.target, props.worktreeId)} {...props} />
}

function AgentTeamControlForm({ target, worktreeId, options, onClose }: AgentTeamControlProps) {
  const providers = useMemo(() => groupProviderOptions(options), [options])
  const initial = providers.find((option) => !option.disabled)?.agent
  const [leaderDraft, setLeader] = useState<GroupWorker[] | null>(null)
  const [workerDraft, setWorkers] = useState<GroupWorker[] | null>(null)
  const leader =
    leaderDraft ?? (initial ? [{ id: 'team-master', agent: initial, spec: '', claims: '' }] : [])
  const workers =
    workerDraft ?? (initial ? [{ id: 'team-worker', agent: initial, spec: '', claims: '' }] : [])
  const [objective, setObjective] = useState('')
  const [parallelismHint, setParallelismHint] = useState(6)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = teamSessionKey(target, worktreeId)
  const [session, setSession] = useState(() => readTeamSession(key))
  const parsedConfiguration = agentTeamConfigurationSchema.safeParse({
    leader: leader[0] && {
      agent: leader[0].agent,
      model: leader[0].model ?? '',
      effort: leader[0].effort
    },
    profiles: workers.map((worker) => ({
      id: worker.id,
      agent: worker.agent,
      model: worker.model ?? '',
      effort: worker.effort,
      purpose: worker.spec
    })),
    parallelismHint
  })
  const configuration = parsedConfiguration.success ? parsedConfiguration.data : null
  const unavailable = [...leader, ...workers].find(
    (worker) => !providers.some((option) => option.agent === worker.agent && !option.disabled)
  )
  const unavailableOption = providers.find((option) => option.agent === unavailable?.agent)
  const availabilityError = unavailable
    ? translate(
        'agentTeam.providerUnavailable',
        '{{provider}} is unavailable on this host. {{reason}} Choose an available provider or restore it before starting.',
        {
          provider: unavailableOption?.label ?? unavailable.agent,
          reason: unavailableOption?.reason ?? ''
        }
      )
    : !initial
      ? translate(
          'agentTeam.noProviders',
          'No eligible agent providers are available on this host.'
        )
      : null
  const canLaunch =
    !!configuration &&
    groupWorkerCanLaunch(leader[0], providers) &&
    workers.every((worker) => groupWorkerCanLaunch(worker, providers))
  function loadConfiguration(next: AgentTeamConfiguration) {
    setLeader([{ id: 'team-master', ...next.leader, spec: '', claims: '' }])
    setWorkers(
      next.profiles.map(({ purpose, ...profile }) => ({ ...profile, spec: purpose, claims: '' }))
    )
    setParallelismHint(next.parallelismHint)
    setError(null)
  }
  async function start() {
    if (busy || !canLaunch || !configuration || !objective.trim()) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await startAgentTeam({
        target,
        worktreeId,
        configuration,
        objective
      })
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSession(readTeamSession(key))
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {translate(
          'agentTeam.description',
          'Give one goal to a master agent. It chooses a worker profile for each task, supervises their work, and handles their reports and questions. Continue the conversation in its panel.'
        )}
      </p>
      {session ? (
        <>
          <Button
            onClick={() => {
              try {
                openMasterSession(worktreeId, session)
                onClose()
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : String(reason))
              }
            }}
          >
            {translate('agentTeam.open', 'Open master chat')}
          </Button>
          <AgentTeamBoard target={target} worktreeId={worktreeId} />
          <details>
            <summary className="cursor-pointer text-sm">
              {translate('agentTeam.another', 'Start another team')}
            </summary>
            <p className="my-2 text-xs text-muted-foreground">
              {translate(
                'agentTeam.detachHelp',
                'This removes the saved team shortcut. Existing agents keep running; their master remains responsible for them.'
              )}
            </p>
            <Button
              variant="outline"
              onClick={() => {
                detachTeamSession(key)
                setSession(null)
              }}
            >
              {translate('agentTeam.detach', 'Detach saved team')}
            </Button>
          </details>
        </>
      ) : (
        <>
          <AgentTeamPresets
            storageKey={agentTeamPresetKey(target, worktreeId)}
            configuration={configuration}
            disabled={busy}
            onLoad={loadConfiguration}
          />
          <Label htmlFor="team-goal">
            {translate('agentTeam.goal', 'What should the team do?')}
          </Label>
          <Textarea
            id="team-goal"
            value={objective}
            disabled={busy}
            onChange={(event) => setObjective(event.target.value)}
          />
          <p className="text-sm font-medium">{translate('agentTeam.master', 'Master agent')}</p>
          <AgentGroupWorkers
            target={target}
            worktreeId={worktreeId}
            workers={leader}
            options={providers}
            writable={false}
            disabled={busy}
            showTasks={false}
            onChange={setLeader}
          />
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">
              {translate('agentTeam.profiles', 'Available worker profiles')}
            </p>
            <p className="text-xs text-muted-foreground">
              {translate(
                'agentTeam.profileHelp',
                'Describe when to use each profile so the master can choose the model for each task. Profiles can be reused across tasks.'
              )}
            </p>
          </div>
          {workers.map((worker, index) => (
            <div
              key={worker.id}
              className="flex min-w-0 flex-col gap-2 border-t border-border pt-4"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {translate('agentTeam.profile', 'Worker profile {{number}}', {
                    number: index + 1
                  })}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || workers.length === 1}
                  aria-label={translate(
                    'agentTeam.removeProfile',
                    'Remove worker profile {{number}}',
                    { number: index + 1 }
                  )}
                  onClick={() => setWorkers(workers.filter((entry) => entry.id !== worker.id))}
                >
                  {translate('agentTeam.remove', 'Remove')}
                </Button>
              </div>
              <AgentGroupWorkers
                target={target}
                worktreeId={worktreeId}
                workers={[worker]}
                options={providers}
                writable={false}
                disabled={busy}
                showTasks={false}
                onChange={([next]) => {
                  if (next) {
                    setWorkers(workers.map((entry) => (entry.id === worker.id ? next : entry)))
                  }
                }}
              />
              <Label htmlFor={`${worker.id}-purpose`}>
                {translate('agentTeam.purpose', 'When should the master use profile {{number}}?', {
                  number: index + 1
                })}
              </Label>
              <Input
                id={`${worker.id}-purpose`}
                value={worker.spec}
                disabled={busy}
                onChange={(event) =>
                  setWorkers(
                    workers.map((entry) =>
                      entry.id === worker.id ? { ...entry, spec: event.target.value } : entry
                    )
                  )
                }
                placeholder={translate(
                  'agentTeam.purposePlaceholder',
                  'For example: routine fixes or complex implementation'
                )}
              />
            </div>
          ))}
          <Button
            variant="outline"
            disabled={busy || !initial}
            onClick={() => {
              if (initial) {
                setWorkers([
                  ...workers,
                  { id: createBrowserUuid(), agent: initial, spec: '', claims: '' }
                ])
              }
            }}
          >
            {translate('agentTeam.addProfile', 'Add worker profile')}
          </Button>
          <Label htmlFor="team-pace">
            {translate('agentTeam.parallelismHint', 'Approximate concurrency / pace')}
          </Label>
          <Input
            id="team-pace"
            type="number"
            min={1}
            step={1}
            value={parallelismHint}
            disabled={busy}
            aria-describedby="team-pace-help"
            onChange={(event) => setParallelismHint(Number(event.target.value))}
          />
          <p id="team-pace-help" className="text-xs text-muted-foreground">
            {translate(
              'agentTeam.paceHelp',
              'A positive whole number to guide the master. It may use fewer or more agents as the work requires.'
            )}
          </p>
          {availabilityError && (
            <p role="alert" className="text-sm text-destructive">
              {availabilityError}
            </p>
          )}
          <Button disabled={busy || !objective.trim() || !canLaunch} onClick={() => void start()}>
            {busy
              ? translate('agentTeam.starting', 'Opening master…')
              : translate('agentTeam.start', 'Start team')}
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
