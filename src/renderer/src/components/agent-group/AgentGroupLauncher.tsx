import { useState } from 'react'
import { Users } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type { TabAgentLaunchOption } from '../tab-bar/tab-agent-launch-options'
import { AgentGroupDialog } from './AgentGroupDialog'

export function AgentGroupLauncher({
  worktreeId,
  options
}: {
  worktreeId: string
  options: TabAgentLaunchOption[]
}) {
  const [target, setTarget] = useState<RuntimeClientTarget | null>(null)
  const label = translate('agentGroup.title', 'Launch agents')
  function open() {
    const resolved = resolveWorktreeOperationRouteResult(useAppStore.getState(), worktreeId)
    if (resolved.kind !== 'resolved') {
      toast.error(
        translate(
          'agentGroup.ownerMissing',
          'The workspace host is unavailable. Reconnect before launching agents.'
        )
      )
      return
    }
    setTarget(
      resolved.route.runtimeEnvironmentId
        ? { kind: 'environment', environmentId: resolved.route.runtimeEnvironmentId }
        : { kind: 'local' }
    )
  }
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="my-auto shrink-0 [-webkit-app-region:no-drag]"
            aria-label={label}
            onClick={open}
          >
            <Users />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      {target && (
        <AgentGroupDialog
          worktreeId={worktreeId}
          target={target}
          options={options}
          onClose={() => setTarget(null)}
        />
      )}
    </>
  )
}
