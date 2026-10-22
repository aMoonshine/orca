import type { TabAgentLaunchOption } from '@/components/tab-bar/tab-agent-launch-options'
import { getAgentSessionOptionCatalog } from '../../../shared/agent-session-option-catalog'
import type { GroupWorker } from './agent-group-launch'

function launchRank(option: TabAgentLaunchOption): number {
  if (option.disabled || option.row?.kind === 'chat-unavailable') {
    return 0
  }
  return option.row?.kind === 'chat' ? 1 : 2
}

export function groupProviderOptions(
  options: readonly TabAgentLaunchOption[]
): TabAgentLaunchOption[] {
  const providers = new Map<string, TabAgentLaunchOption>()
  for (const option of options) {
    const previous = providers.get(option.agent)
    if (!previous || launchRank(option) > launchRank(previous)) {
      providers.set(option.agent, {
        ...option,
        id: option.agent,
        disabled: launchRank(option) === 0
      })
    }
  }
  return [...providers.values()]
}

export function groupWorkerCanLaunch(
  worker: GroupWorker | undefined,
  options: readonly TabAgentLaunchOption[]
): boolean {
  return !!(
    worker &&
    options.some((option) => option.agent === worker.agent && launchRank(option) > 0) &&
    (getAgentSessionOptionCatalog(worker.agent)?.supportsWorkerLaunchPreferences
      ? worker.model?.trim()
      : !worker.model?.trim())
  )
}
