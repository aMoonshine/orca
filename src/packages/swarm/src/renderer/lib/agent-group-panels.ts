import { z } from 'zod'
import { useAppStore } from '@/store'
import type { GroupReceipt, GroupRpc } from './agent-group-launch'
import { agentPanelSplitRatios, planAgentPanelSplit } from './agent-panel-placement'

const terminalSchema = z.object({
  terminal: z.object({ tabId: z.string(), worktreeId: z.string() })
})

/** Move existing team tabs, preserving their PTYs and every unrelated tab. */
export async function showAgentGroupPanels(
  rpc: GroupRpc,
  receipts: GroupReceipt[],
  preserveActiveTab = false,
  membership?: Set<string>,
  isCurrent: () => boolean = () => true
): Promise<number> {
  const terminals: { worktreeId: string; tabId: string }[] = []
  for (const receipt of receipts) {
    const terminal = receipt.effects?.find(
      (effect) => effect.kind === 'terminal' && effect.role === 'agent'
    )
    if (!terminal?.id || terminal.id.startsWith('orca_session_id:')) {
      continue
    }
    try {
      const result = terminalSchema.parse(await rpc('terminal.show', { terminal: terminal.id }))
      terminals.push(result.terminal)
    } catch {
      // A closed or structured worker has no terminal pane to arrange.
    }
  }
  if (!isCurrent()) {
    return 0
  }
  const initial = useAppStore.getState()
  const tabsByWorktree = new Map<string, string[]>()
  for (const { worktreeId, tabId } of terminals) {
    const tab = initial.unifiedTabsByWorktree[worktreeId]?.find(
      (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
    )
    if (tab) {
      const tabs = tabsByWorktree.get(worktreeId) ?? []
      if (!tabs.includes(tab.id)) {
        tabs.push(tab.id)
      }
      tabsByWorktree.set(worktreeId, tabs)
    }
  }
  const visible = [...tabsByWorktree.values()].flat()
  if (membership?.size === visible.length && visible.every((id) => membership.has(id))) {
    return visible.length
  }
  for (const [worktreeId, tabIds] of tabsByWorktree) {
    const state = useAppStore.getState()
    const activeGroup = state.activeGroupIdByWorktree[worktreeId]
    const activeTab = state.groupsByWorktree[worktreeId]?.find(
      (group) => group.id === activeGroup
    )?.activeTabId
    const anchor = state.getTab(tabIds[0])
    if (!anchor) {
      continue
    }
    let anchorGroupId = anchor.groupId
    const anchorActiveTab = state.groupsByWorktree[worktreeId]?.find(
      (group) => group.id === anchor.groupId
    )?.activeTabId
    const hasUnrelatedTabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).some(
      (tab) =>
        tab.groupId === anchor.groupId &&
        !tabIds.includes(tab.id) &&
        (tab.contentType !== 'terminal' || tab.id === anchorActiveTab)
    )
    if (hasUnrelatedTabs) {
      const teamGroup = state.createEmptySplitGroup(worktreeId, anchor.groupId, 'down', {
        activate: false
      })
      if (!teamGroup) {
        continue
      }
      useAppStore.getState().moveUnifiedTabToGroup(anchor.id, teamGroup, {
        activate: false,
        recordInteraction: false
      })
      anchorGroupId = teamGroup
    }
    for (const tabId of tabIds.slice(1)) {
      useAppStore.getState().moveUnifiedTabToGroup(tabId, anchorGroupId, {
        activate: false,
        recordInteraction: false
      })
    }
    function split(ids: string[], groupId: string, rows?: number) {
      if (ids.length < 2) {
        useAppStore.getState().activateTab(ids[0], { worktreeId, recordFocus: false })
        return
      }
      const { firstCount, firstRows, secondRows, direction } = planAgentPanelSplit(ids.length, rows)
      const nextGroup = useAppStore
        .getState()
        .createEmptySplitGroup(worktreeId, groupId, direction, { activate: false })
      if (!nextGroup) {
        return
      }
      const first = ids.slice(0, firstCount)
      const second = ids.slice(firstCount)
      for (const tabId of second) {
        useAppStore.getState().moveUnifiedTabToGroup(tabId, nextGroup, {
          activate: false,
          recordInteraction: false
        })
      }
      split(first, groupId, firstRows)
      split(second, nextGroup, secondRows)
    }
    split(tabIds, anchorGroupId)
    const arranged = useAppStore.getState()
    const groups = new Set(
      (arranged.unifiedTabsByWorktree[worktreeId] ?? [])
        .filter((tab) => tabIds.includes(tab.id))
        .map((tab) => tab.groupId)
    )
    const layout = arranged.layoutByWorktree[worktreeId]
    if (layout) {
      for (const { path, ratio } of agentPanelSplitRatios(layout, groups)) {
        useAppStore.getState().setTabGroupSplitRatio(worktreeId, path, ratio)
      }
    }
    if (preserveActiveTab && activeTab) {
      useAppStore.getState().activateTab(activeTab, {
        worktreeId,
        recordFocus: false,
        preservePreview: true
      })
    }
  }
  membership?.clear()
  for (const id of visible) {
    membership?.add(id)
  }
  return visible.length
}
