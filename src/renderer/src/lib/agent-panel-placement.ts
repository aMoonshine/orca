import type { TabGroupLayoutNode } from '../../../shared/tab-types'

export function chooseAgentPanelSplit(
  layout: TabGroupLayoutNode | undefined,
  groups: string[]
): { groupId: string; splitDirection: 'right' | 'down' } {
  const leaves: { groupId: string; width: number; height: number }[] = []
  function visit(node: TabGroupLayoutNode, width: number, height: number) {
    if (node.type === 'leaf') {
      if (groups.includes(node.groupId)) {
        leaves.push({ groupId: node.groupId, width, height })
      }
      return
    }
    const ratio = node.ratio ?? 0.5
    const horizontal = node.direction === 'horizontal'
    visit(node.first, horizontal ? width * ratio : width, horizontal ? height : height * ratio)
    visit(
      node.second,
      horizontal ? width * (1 - ratio) : width,
      horizontal ? height : height * (1 - ratio)
    )
  }
  if (layout) {
    visit(layout, 1.6, 1)
  }
  leaves.sort((a, b) => b.width * b.height - a.width * a.height)
  const largest = leaves[0]
  return {
    groupId: largest?.groupId ?? groups[0],
    splitDirection: !largest || largest.width >= largest.height ? 'right' : 'down'
  }
}
