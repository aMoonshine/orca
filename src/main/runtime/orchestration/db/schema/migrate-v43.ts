import type { OrchestrationDb } from '../orchestration-db'

/**
 * Per-path edit ownership for workers sharing a workspace.
 *
 * Why a migration and not only `createTables`: `CREATE TABLE IF NOT EXISTS` does
 * nothing for a database opened at an earlier version, so without this step an
 * existing profile has no `worker_file_claims` and every claim fails as "no such
 * table" while a fresh install works. The v42 precedent applies - the createTables
 * SQL is guarded because it runs first on every open and already gives a fresh
 * database this table.
 */
export function migrateV43(this: OrchestrationDb, current: number): void {
  if (current >= 43) {
    return
  }
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS worker_file_claims (
      run_id        TEXT NOT NULL,
      workspace_id  TEXT NOT NULL,
      claim_key     TEXT NOT NULL,
      display_path  TEXT NOT NULL,
      dispatch_id   TEXT NOT NULL,
      claimed_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (run_id, workspace_id, claim_key)
    );
    CREATE INDEX IF NOT EXISTS idx_worker_file_claims_dispatch
      ON worker_file_claims(dispatch_id);
    CREATE INDEX IF NOT EXISTS idx_worker_file_claims_scope
      ON worker_file_claims(run_id, workspace_id);
  `)
}
