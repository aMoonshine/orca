import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { showAgentGroupPanels } from './agent-group-panels'
import type { GroupRpc } from './agent-group-launch'

describe('agent group panels', () => {
  it.each([6, 20])(
    'shows %i existing agent terminals without replacing unrelated tabs',
    async (count) => {
      const worktreeId = 'group-panel-test'
      useAppStore.setState({
        activeWorktreeId: worktreeId,
        groupsByWorktree: {},
        unifiedTabsByWorktree: {},
        layoutByWorktree: {},
        activeGroupIdByWorktree: {}
      })
      const store = useAppStore.getState()
      const editor = store.createUnifiedTab(worktreeId, 'editor', { entityId: 'README.md' })
      const agents = Array.from({ length: count }, (_, i) =>
        store.createUnifiedTab(worktreeId, 'terminal', { entityId: `agent-${i}` })
      )
      const receipts = agents.map((tab) => ({
        state: 'ready',
        effects: [{ kind: 'terminal', role: 'agent', id: tab.entityId }]
      }))
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture implements only the terminal.show response consumed by the presenter.
      const rpc = (async (_method: string, params: { terminal: string }) => ({
        terminal: { tabId: params.terminal, worktreeId }
      })) as GroupRpc
      await showAgentGroupPanels(rpc, receipts)
      await showAgentGroupPanels(rpc, receipts)
      const state = useAppStore.getState()
      const tabs = state.unifiedTabsByWorktree[worktreeId]
      const workers = tabs.filter((tab) => tab.contentType === 'terminal')
      expect(new Set(workers.map((tab) => tab.groupId)).size).toBe(count)
      expect(state.groupsByWorktree[worktreeId].map((group) => group.activeTabId)).toEqual(
        expect.arrayContaining(agents.map((tab) => tab.id))
      )
      expect(tabs.find((tab) => tab.id === editor.id)?.entityId).toBe('README.md')
    }
  )
})
