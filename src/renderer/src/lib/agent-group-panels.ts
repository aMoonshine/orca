import { z } from 'zod'
import { useAppStore } from '@/store'
import type { GroupReceipt, GroupRpc } from './agent-group-launch'

const terminalSchema = z.object({
  terminal: z.object({ tabId: z.string(), worktreeId: z.string() })
})

/** Move existing worker tabs, preserving their PTYs and every unrelated tab. */
export async function showAgentGroupPanels(rpc: GroupRpc, receipts: GroupReceipt[]): Promise<void> {
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
    if (!tab) {
      continue
    }
    const prior = arranged
      .map((id) => visibleTabs.find((entry) => entry.id === id))
      .filter((entry) => entry !== undefined)
    const shared = prior.some((entry) => entry.groupId === tab.groupId)
    if (shared) {
      const anchor = prior.length === 1 ? prior[0] : prior[(prior.length - 2) % 2]
      state.dropUnifiedTab(tab.id, {
        groupId: anchor.groupId,
        splitDirection: prior.length === 1 ? 'right' : 'down'
      })
    }
    useAppStore.getState().activateTab(tab.id, { worktreeId })
    arranged.push(tab.id)
  }
}
