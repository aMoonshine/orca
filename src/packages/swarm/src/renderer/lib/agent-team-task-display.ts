import { z } from 'zod'

const report = z.object({ body: z.string() })
export function teamTaskLane(status: string, requiresAction = false): string {
  if (status === 'completed' || status === 'succeeded') {
    return 'reported'
  }
  if (requiresAction) {
    return 'attention'
  }
  if (status === 'pending' || status === 'ready') {
    return 'pending'
  }
  if (['dispatched', 'running', 'in_progress'].includes(status)) {
    return 'working'
  }
  return 'attention'
}
export function teamTaskReport(result: string | null, spec: string): string {
  if (!result) {
    return spec
  }
  try {
    const parsed = report.safeParse(JSON.parse(result))
    return parsed.success ? parsed.data.body : result
  } catch {
    return result
  }
}
