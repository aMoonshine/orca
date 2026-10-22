import type { OrchestrationDb } from '../orchestration-db'
import { migrateV43 } from './migrate-v43'
import { migrateForkFileClaims } from './migrate-fork-file-claims'

// Fork v43-v45 and upstream v43 used different migrations. Repair both lineages.
export function migrateV46(this: OrchestrationDb, current: number): void {
  if (current >= 46) {
    return
  }
  migrateForkFileClaims.call(this)
  migrateV43.call(this, 0)
}
