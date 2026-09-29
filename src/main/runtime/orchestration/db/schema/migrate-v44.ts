import type { OrchestrationDb } from '../orchestration-db'

/**
 * Standing decision contracts, per the multi-agent mode spec.
 *
 * Why a migration and not only `createTables`: `CREATE TABLE IF NOT EXISTS` does
 * nothing for a profile opened at an earlier version, and without this step every
 * read and write against `run_decisions` fails as "no such table" on exactly the
 * long-lived installs that already have orchestration data. Guarded inside because
 * createTables runs first on every open and already gives a fresh database these.
 */
export function migrateV44(this: OrchestrationDb, current: number): void {
  if (current >= 44) {
    return
  }
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS run_decisions (
      id                TEXT PRIMARY KEY,
      run_id            TEXT NOT NULL,
      proposed_by       TEXT NOT NULL,
      title             TEXT NOT NULL,
      contract          TEXT NOT NULL,
      rationale         TEXT NOT NULL DEFAULT '',
      affects           TEXT NOT NULL DEFAULT '[]',
      supersedes        TEXT,
      status            TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open', 'frozen', 'withdrawn')),
      frozen_at         TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_run_decisions_run
      ON run_decisions(run_id, status);
    CREATE INDEX IF NOT EXISTS idx_run_decisions_supersedes
      ON run_decisions(supersedes) WHERE supersedes IS NOT NULL;
    CREATE TABLE IF NOT EXISTS decision_responses (
      decision_id       TEXT NOT NULL,
      dispatch_id       TEXT NOT NULL,
      stance            TEXT NOT NULL CHECK(stance IN ('accepted', 'objected')),
      note              TEXT NOT NULL DEFAULT '',
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (decision_id, dispatch_id)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_responses_objected
      ON decision_responses(decision_id) WHERE stance = 'objected';
  `)
}
