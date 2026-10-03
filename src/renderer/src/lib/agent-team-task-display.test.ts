import { expect, it } from 'vitest'
import { teamTaskLane, teamTaskReport } from './agent-team-task-display'
it('surfaces host-reported attention without inventing a failed task', () => {
  expect(teamTaskLane('dispatched', true)).toBe('attention')
  expect(teamTaskLane('dispatched', false)).toBe('working')
  expect(teamTaskLane('completed', true)).toBe('reported')
  expect(teamTaskLane('future-status')).toBe('attention')
})
it('shows readable reports and preserves legacy text', () => {
  expect(teamTaskReport('{"body":"Found a bug","outcome":"succeeded"}', 'spec')).toBe('Found a bug')
  expect(teamTaskReport('Legacy result', 'spec')).toBe('Legacy result')
  expect(teamTaskReport(null, 'spec')).toBe('spec')
})
