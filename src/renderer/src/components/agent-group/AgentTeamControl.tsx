import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { readTeamSession, startAgentTeam, teamSessionKey } from '@/lib/agent-team-session'
import type { GroupWorker } from '@/lib/agent-group-launch'
import type { TabAgentLaunchOption } from '../tab-bar/tab-agent-launch-options'
import { AgentGroupWorkers } from './AgentGroupWorkers'
import { AgentTeamBoard } from './AgentTeamBoard'

export function AgentTeamControl({
  target,
  worktreeId,
  options,
  onClose
}: {
  target: RuntimeClientTarget
  worktreeId: string
  options: TabAgentLaunchOption[]
  onClose: () => void
}) {
  const initial = options[0]?.agent ?? 'opencode'
  const [leader, setLeader] = useState<GroupWorker[]>([
    { id: 'team-master', agent: initial, spec: '', claims: '' }
  ])
  const [worker, setWorker] = useState<GroupWorker[]>([
    { id: 'team-worker', agent: initial, spec: '', claims: '' }
  ])
  const [objective, setObjective] = useState('')
  const [count, setCount] = useState(6)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = teamSessionKey(target, worktreeId)
  const [session, setSession] = useState(() => readTeamSession(key))
  async function start() {
    setBusy(true)
    setError(null)
    try {
      await startAgentTeam({
        target,
        worktreeId,
        leader: leader[0].agent,
        leaderModel: leader[0].model ?? '',
        agent: worker[0].agent,
        model: worker[0].model ?? '',
        count,
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
          'Give one goal to a master agent. It assigns tasks, starts workers with the selected model, and handles their reports and questions. Continue the conversation in its panel.'
        )}
      </p>
      {session ? (
        <>
          <Button
            onClick={() => {
              const state = useAppStore.getState()
              const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
                (entry) => entry.id === session.tabId || entry.entityId === session.tabId
              )
              if (!tab) {
                setError(
                  'The master panel is unavailable. Inspect the workspace before starting another team.'
                )
                return
              }
              state.activateTab(tab.id, { worktreeId })
              onClose()
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
                localStorage.removeItem(key)
                setSession(null)
              }}
            >
              {translate('agentTeam.detach', 'Detach saved team')}
            </Button>
          </details>
        </>
      ) : (
        <>
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
            options={options}
            writable={false}
            disabled={busy}
            showTasks={false}
            onChange={setLeader}
          />
          <p className="text-sm font-medium">{translate('agentTeam.workers', 'Worker defaults')}</p>
          <AgentGroupWorkers
            target={target}
            worktreeId={worktreeId}
            workers={worker}
            options={options}
            writable={false}
            disabled={busy}
            showTasks={false}
            onChange={setWorker}
          />
          <Label htmlFor="team-count">{translate('agentTeam.count', 'Workers (1–20)')}</Label>
          <Input
            id="team-count"
            type="number"
            min={1}
            max={20}
            value={count}
            disabled={busy}
            onChange={(event) => setCount(Number(event.target.value))}
          />
          <Button
            disabled={
              busy ||
              !objective.trim() ||
              !leader[0].model ||
              !worker[0].model ||
              !Number.isInteger(count) ||
              count < 1 ||
              count > 20 ||
              !options.length
            }
            onClick={() => void start()}
          >
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
