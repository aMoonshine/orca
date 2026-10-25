import type { TabGroupLayoutNode } from '../../../../../shared/tab-types'

export function planAgentPanelSplit(
  count: number,
  rows = Math.ceil(count / Math.ceil(Math.sqrt(count * 1.6)))
) {
  const firstRows = Math.ceil(rows / 2)
  const firstCount = rows > 1 ? Math.ceil((count * firstRows) / rows) : Math.ceil(count / 2)
  return {
    firstCount,
    firstRows,
    secondRows: Math.max(1, rows - firstRows),
    direction: rows > 1 ? ('down' as const) : ('right' as const)
  }
}

export function agentPanelSplitRatios(
  layout: TabGroupLayoutNode,
  groupIds: Set<string>
): { path: string; ratio: number }[] {
  const ratios: { path: string; ratio: number }[] = []
  function visit(node: TabGroupLayoutNode, path: string): { count: number; teamOnly: boolean } {
    if (node.type === 'leaf') {
      return { count: 1, teamOnly: groupIds.has(node.groupId) }
    }
    const first = visit(node.first, path ? `${path}.first` : 'first')
    const second = visit(node.second, path ? `${path}.second` : 'second')
    const count = first.count + second.count
    const teamOnly = first.teamOnly && second.teamOnly
    if (teamOnly) {
      ratios.push({ path, ratio: first.count / count })
    }
    return { count, teamOnly }
  }
  visit(layout, '')
  return ratios
}
