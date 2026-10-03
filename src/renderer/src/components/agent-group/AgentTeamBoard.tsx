import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useAgentTeam } from '@/lib/use-agent-team'
import { AgentGroupInbox } from './AgentGroupInbox'
import { useState } from 'react'
import { teamTaskReport, teamTaskLane } from '@/lib/agent-team-task-display'

const lanes = [
  { id: 'pending', label: 'To do' },
  { id: 'working', label: 'In progress' },
  { id: 'reported', label: 'Reported' },
  { id: 'attention', label: 'Needs attention' }
]
export function AgentTeamBoard({
  target,
  worktreeId
}: {
  target: RuntimeClientTarget
  worktreeId: string
}) {
  const team = useAgentTeam(target, worktreeId)
  const [openError, setOpenError] = useState<string | null>(null)
  return (
    <div className="flex min-h-0 flex-col gap-3">
      {openError && (
        <p role="alert" className="text-sm text-destructive">
          {openError}
        </p>
      )}
      {team.error && (
        <p role="alert" className="text-sm text-destructive">
          {team.error}
        </p>
      )}
      {!team.run ? (
        <p className="text-sm text-muted-foreground">
          {translate(
            'agentTeam.noRun',
            'The master’s tasks appear here after it creates a Run. Open the master panel for setup questions or launch errors.'
          )}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {translate(
              'agentTeam.boardNote',
              'Updates every 5 seconds. Reported means the worker submitted a result; read the master’s review before accepting it.'
            )}
          </p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {lanes.map((lane) => (
              <section key={lane.id} className="flex min-w-0 flex-col gap-2">
                <h3 className="text-sm font-medium">
                  {translate(`agentTeam.lane.${lane.id}`, lane.label)}
                </h3>
                {team.tasks
                  .filter(
                    (task) =>
                      teamTaskLane(
                        task.status,
                        team.workers.find((worker) => worker.taskId === task.id)?.projection
                          ?.attention.requiresAction
                      ) === lane.id
                  )
                  .map((task) => {
                    const handle = team.workers.find(
                      (worker) => worker.taskId === task.id
                    )?.agentTerminalHandle
                    return (
                      <details key={task.id} className="rounded-md border p-3 text-xs">
                        <summary className="cursor-pointer break-words line-clamp-3">
                          {task.task_title ?? task.spec.split('\n')[0]}
                        </summary>
                        <p className="mt-2 whitespace-pre-wrap break-words">
                          {teamTaskReport(task.result, task.spec)}
                        </p>
                        {handle && (
                          <Button
                            className="mt-2"
                            size="xs"
                            variant="outline"
                            onClick={() =>
                              void callRuntimeRpc(target, 'terminal.focus', {
                                terminal: handle,
                                navigation: 'caller'
                              }).catch((reason: unknown) =>
                                setOpenError(
                                  reason instanceof Error ? reason.message : String(reason)
                                )
                              )
                            }
                          >
                            {translate('agentTeam.openWorker', 'Open agent')}
                          </Button>
                        )}
                      </details>
                    )
                  })}
              </section>
            ))}
          </div>
          <AgentGroupInbox run={team.run} target={target} />
        </>
      )}
    </div>
  )
}
