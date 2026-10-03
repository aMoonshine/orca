import { z } from 'zod'
import { useAppStore } from '@/store'
import type { GroupReceipt, GroupRpc } from './agent-group-launch'
import { chooseAgentPanelSplit } from './agent-panel-placement'

const terminalSchema = z.object({
  terminal: z.object({ tabId: z.string(), worktreeId: z.string() })
})

/** Move existing worker tabs, preserving their PTYs and every unrelated tab. */
export async function showAgentGroupPanels(
  rpc: GroupRpc,
  receipts: GroupReceipt[],
  preserveActiveTab = false
): Promise<number> {
  const initial = useAppStore.getState()
  const activeWorktree = initial.activeWorktreeId
  const initialGroup = activeWorktree ? initial.activeGroupIdByWorktree[activeWorktree] : undefined
  const initialTab = activeWorktree
    ? initial.groupsByWorktree[activeWorktree]?.find((group) => group.id === initialGroup)
        ?.activeTabId
    : undefined
  const tabs: { worktreeId: string; tabId: string }[] = []
  for (const receipt of receipts) {
    const terminal = receipt.effects?.find(
      (effect) => effect.kind === 'terminal' && effect.role === 'agent'
    )
    if (!terminal?.id || terminal.id.startsWith('session:')) {
      continue
    }
    try {
      const result = terminalSchema.parse(await rpc('terminal.show', { terminal: terminal.id }))
      tabs.push({ worktreeId: result.terminal.worktreeId, tabId: result.terminal.tabId })
    } catch {
      // A closed or structured worker has no terminal pane to arrange.
    }
  }
  const arranged: string[] = []
  for (const { worktreeId, tabId } of tabs) {
    const state = useAppStore.getState()
    const visibleTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
    const tab = visibleTabs.find(
      (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
    )
    if (!tab || arranged.includes(tab.id)) {
      continue
    }
    const prior = arranged
      .map((id) => visibleTabs.find((entry) => entry.id === id))
      .filter((entry) => entry !== undefined)
    const shared = prior.some((entry) => entry.groupId === tab.groupId)
    if (shared) {
      state.dropUnifiedTab(
        tab.id,
        chooseAgentPanelSplit(
          state.layoutByWorktree[worktreeId],
          prior.map((entry) => entry.groupId)
        )
      )
    }
    useAppStore.getState().activateTab(tab.id, { worktreeId })
    arranged.push(tab.id)
  }
  if (
    preserveActiveTab &&
    activeWorktree &&
    initialTab &&
    arranged.includes(initialTab) &&
    useAppStore.getState().activeWorktreeId === activeWorktree
  ) {
    useAppStore.getState().activateTab(initialTab, { worktreeId: activeWorktree })
  }
  return arranged.length
}
