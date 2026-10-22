import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { showAgentGroupPanels } from './agent-group-panels'
import type { GroupReceipt, GroupRpc } from './agent-group-launch'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'

const worktreeId = 'folder:group-panel-test'
const receipts: GroupReceipt[] = []
const closed = new Set<string>()
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture serves only the terminal.show response consumed by the presenter.
const rpc = (async (_method: string, params: { terminal: string }) => {
  if (closed.has(params.terminal)) {
    throw new Error('Terminal closed')
  }
  return { terminal: { tabId: params.terminal, worktreeId } }
}) as GroupRpc

function addAgent(entityId: string, beside?: string) {
  const state = useAppStore.getState()
  const tab = beside
    ? state.createUnifiedTabInSplit(
        worktreeId,
        'terminal',
        {
          sourceGroupId: beside,
          splitDirection: 'right'
        },
        { entityId }
      )
    : state.createUnifiedTab(worktreeId, 'terminal', { entityId })
  if (!tab) {
    throw new Error('Agent tab was not created')
  }
  receipts.push({ state: 'ready', effects: [{ kind: 'terminal', role: 'agent', id: entityId }] })
  return tab
}

function rectangles(
  layout: TabGroupLayoutNode,
  x = 0,
  y = 0,
  width = 1,
  height = 1
): { groupId: string; x: number; y: number; width: number; height: number }[] {
  if (layout.type === 'leaf') {
    return [{ groupId: layout.groupId, x, y, width, height }]
  }
  const ratio = layout.ratio ?? 0.5
  return layout.direction === 'horizontal'
    ? [
        ...rectangles(layout.first, x, y, width * ratio, height),
        ...rectangles(layout.second, x + width * ratio, y, width * (1 - ratio), height)
      ]
    : [
        ...rectangles(layout.first, x, y, width, height * ratio),
        ...rectangles(layout.second, x, y + height * ratio, width, height * (1 - ratio))
      ]
}

function expectEqualPanels(count: number) {
  const state = useAppStore.getState()
  const panels = rectangles(state.layoutByWorktree[worktreeId])
  expect(panels).toHaveLength(count)
  for (const panel of panels) {
    expect(panel.width * panel.height).toBeCloseTo(1 / count, 10)
  }
  const tabs = state.unifiedTabsByWorktree[worktreeId].filter(
    (tab) => tab.contentType === 'terminal'
  )
  expect(new Set(tabs.map((tab) => tab.groupId)).size).toBe(count)
  for (const tab of tabs) {
    expect(
      state.groupsByWorktree[worktreeId].find((group) => group.id === tab.groupId)?.activeTabId
    ).toBe(tab.id)
  }
  return panels
}

beforeEach(() => {
  receipts.length = 0
  closed.clear()
  useAppStore.setState({
    activeWorktreeId: worktreeId,
    groupsByWorktree: {},
    unifiedTabsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    terminalLayoutsByTabId: {}
  })
})

describe('agent group panels', () => {
  it('keeps Terminal1 with the master while balancing a chain of six worker splits', async () => {
    const companion = useAppStore.getState().createUnifiedTab(worktreeId, 'terminal', {
      entityId: 'Terminal1'
    })
    const master = addAgent('master')
    let previous = master
    for (let i = 0; i < 6; i++) {
      previous = addAgent(`worker-${i}`, previous.groupId)
    }
    useAppStore.getState().activateTab(master.id, { worktreeId })
    const identities = useAppStore.getState().unifiedTabsByWorktree[worktreeId]
    const membership = new Set<string>()

    await showAgentGroupPanels(rpc, receipts, true, membership)

    const state = useAppStore.getState()
    const masterGroup = state.getTab(master.id)?.groupId
    expect(state.getTab(companion.id)?.groupId).toBe(masterGroup)
    expect(state.groupsByWorktree[worktreeId]).toHaveLength(7)
    expect(
      state.groupsByWorktree[worktreeId].find((group) => group.id === masterGroup)?.activeTabId
    ).toBe(master.id)
    expect(state.getActiveTab(worktreeId)?.id).toBe(master.id)
    expect(state.unifiedTabsByWorktree[worktreeId].map((tab) => [tab.id, tab.entityId])).toEqual(
      identities.map((tab) => [tab.id, tab.entityId])
    )
    for (const panel of rectangles(state.layoutByWorktree[worktreeId])) {
      expect(panel.width * panel.height).toBeCloseTo(1 / 7, 10)
    }
    state.setTabGroupSplitRatio(worktreeId, '', 0.72)
    const manual = useAppStore.getState().layoutByWorktree[worktreeId]
    await showAgentGroupPanels(rpc, receipts, true, membership)
    expect(useAppStore.getState().layoutByWorktree[worktreeId]).toBe(manual)
  })

  it.each([2, 3, 6, 20])(
    'balances a master and %i workers from a chain of splits',
    async (count) => {
      const master = addAgent('master')
      let previous = master
      for (let i = 0; i < count; i++) {
        previous = addAgent(`worker-${i}`, previous.groupId)
      }
      const identities = useAppStore
        .getState()
        .unifiedTabsByWorktree[worktreeId].map((tab) => [tab.id, tab.entityId])
      const terminalLayouts = useAppStore.getState().terminalLayoutsByTabId
      await showAgentGroupPanels(rpc, receipts)
      const panels = expectEqualPanels(count + 1)
      expect(
        useAppStore
          .getState()
          .unifiedTabsByWorktree[worktreeId].map((tab) => [tab.id, tab.entityId])
      ).toEqual(identities)
      expect(useAppStore.getState().terminalLayoutsByTabId).toBe(terminalLayouts)
      if (count === 6) {
        expect(panels.filter((panel) => panel.y === 0)).toHaveLength(4)
        expect(new Set(panels.map((panel) => panel.y)).size).toBe(2)
        expect(Math.min(...panels.map((panel) => panel.width))).toBeCloseTo(1 / 4)
      }
    }
  )

  it('rebalances all seven panels as workers arrive and preserves manual ratios between arrivals', async () => {
    const master = addAgent('master')
    const membership = new Set<string>()
    await showAgentGroupPanels(rpc, receipts, true, membership)
    for (let i = 0; i < 6; i++) {
      const last = useAppStore.getState().unifiedTabsByWorktree[worktreeId].at(-1)
      addAgent(`worker-${i}`, last?.groupId)
      useAppStore.getState().activateTab(master.id, { worktreeId })
      await showAgentGroupPanels(rpc, receipts, true, membership)
      expectEqualPanels(i + 2)
      expect(useAppStore.getState().getActiveTab(worktreeId)?.id).toBe(master.id)
      useAppStore.getState().setTabGroupSplitRatio(worktreeId, '', 0.71)
      const manual = useAppStore.getState().layoutByWorktree[worktreeId]
      await showAgentGroupPanels(rpc, receipts.toReversed(), true, membership)
      expect(useAppStore.getState().layoutByWorktree[worktreeId]).toBe(manual)
    }
  })

  it('ignores closed handles and waits for a replacement tab to become visible', async () => {
    addAgent('master')
    const old = addAgent('old')
    addAgent('survivor')
    const membership = new Set<string>()
    await showAgentGroupPanels(rpc, receipts, true, membership)
    useAppStore
      .getState()
      .closeUnifiedTab(old.id, { terminalRetirementHandled: true, recordInteraction: false })
    closed.add('old')
    await showAgentGroupPanels(rpc, receipts, true, membership)
    expectEqualPanels(2)
    const waiting: GroupReceipt = {
      state: 'ready',
      effects: [{ kind: 'terminal', role: 'agent', id: 'replacement' }]
    }
    useAppStore.getState().setTabGroupSplitRatio(worktreeId, '', 0.68)
    const manual = useAppStore.getState().layoutByWorktree[worktreeId]
    await showAgentGroupPanels(rpc, [...receipts, waiting], true, membership)
    expect(useAppStore.getState().layoutByWorktree[worktreeId]).toBe(manual)
    const replacement = addAgent('replacement')
    await showAgentGroupPanels(rpc, receipts, true, membership)
    expectEqualPanels(3)
    expect(membership.has(old.id)).toBe(false)
    expect(membership.has(replacement.id)).toBe(true)
    useAppStore.getState().setTabGroupSplitRatio(worktreeId, '', 0.63)
    const resized = useAppStore.getState().layoutByWorktree[worktreeId]
    await showAgentGroupPanels(rpc, receipts, true, membership)
    expect(useAppStore.getState().layoutByWorktree[worktreeId]).toBe(resized)
  })

  it('preserves unrelated tabs, groups, outer ratios and the focused editor', async () => {
    const master = addAgent('master')
    const state = useAppStore.getState()
    const editor = state.createUnifiedTabInSplit(
      worktreeId,
      'editor',
      {
        sourceGroupId: master.groupId,
        splitDirection: 'right'
      },
      { entityId: 'README.md' }
    )
    if (!editor) {
      throw new Error('Editor tab was not created')
    }
    state.setTabGroupSplitRatio(worktreeId, '', 0.64)
    addAgent('worker-1', master.groupId)
    addAgent('worker-2', master.groupId)
    useAppStore.getState().activateTab(editor.id, { worktreeId })
    const editorTab = useAppStore.getState().getTab(editor.id)
    const editorGroup = useAppStore
      .getState()
      .groupsByWorktree[worktreeId].find((group) => group.id === editor.groupId)
    await showAgentGroupPanels(rpc, receipts, true, new Set())
    const after = useAppStore.getState()
    expect(after.getTab(editor.id)).toEqual(editorTab)
    expect(after.groupsByWorktree[worktreeId].find((group) => group.id === editor.groupId)).toEqual(
      editorGroup
    )
    expect(after.getActiveTab(worktreeId)?.id).toBe(editor.id)
    const panels = rectangles(after.layoutByWorktree[worktreeId])
    expect(panels.find((panel) => panel.groupId === editor.groupId)?.width).toBeCloseTo(0.36)
    for (const panel of panels.filter((panel) => panel.groupId !== editor.groupId)) {
      expect(panel.width * panel.height).toBeCloseTo(0.64 / 3)
    }
  })

  it('does not mutate layout when a team monitor is disposed during terminal resolution', async () => {
    addAgent('master')
    addAgent('worker')
    const before = useAppStore.getState()
    const membership = new Set<string>()
    await showAgentGroupPanels(rpc, receipts, true, membership, () => false)
    expect(useAppStore.getState()).toBe(before)
    expect(membership.size).toBe(0)
  })

  it('keeps a focused unrelated tab visible when it initially shares the master group', async () => {
    const master = addAgent('master')
    const worker = addAgent('worker')
    const editor = useAppStore.getState().createUnifiedTab(worktreeId, 'editor', {
      entityId: 'notes.md',
      isPreview: true
    })
    const before = useAppStore.getState().getTab(editor.id)
    await showAgentGroupPanels(rpc, receipts, true, new Set())
    const state = useAppStore.getState()
    expect(state.getTab(editor.id)).toEqual(before)
    expect(state.getActiveTab(worktreeId)?.id).toBe(editor.id)
    expect(state.groupsByWorktree[worktreeId]).toHaveLength(3)
    for (const tab of [master, worker]) {
      const groupId = state.getTab(tab.id)?.groupId
      expect(groupId).not.toBe(editor.groupId)
      expect(
        state.groupsByWorktree[worktreeId].find((group) => group.id === groupId)?.activeTabId
      ).toBe(tab.id)
    }
  })
})
