import type { OrchestrationDb } from '../orchestration-db'

/**
 * Work mode and phase on a Run.
 *
 * `mode`/`mode_phase`/`mode_phase_round` are added with guarded ALTERs because
 * `CREATE TABLE IF NOT EXISTS` in createTables does nothing for a profile opened at an
 * earlier version, and the createTables SQL above is only what a fresh database gets.
 * SQLite cannot add a CHECK constraint to an existing table, so the mode check exists
 * only on the create path and this migration validates what it can; the value is
 * still re-checked in code by `resolveWorkMode` before it is trusted.
 */
export function migrateV45(this: OrchestrationDb, current: number): void {
  if (current >= 45) {
    return
  }
  for (const [column, definition] of [
    ['mode', "TEXT NOT NULL DEFAULT 'solo'"],
    ['mode_phase', "TEXT NOT NULL DEFAULT 'work'"],
    ['mode_phase_round', 'INTEGER NOT NULL DEFAULT 1']
  ] as const) {
    if (!this.hasColumn('runs', column)) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN ${column} ${definition}`)
    }
  }
  // A legacy Run has no protocol behind it, so it lands on solo/work rather than
  // inheriting a phase name that its pre-v45 rows never satisfied.
  this.db.exec(`
    UPDATE runs SET mode = 'solo', mode_phase = 'work'
    WHERE mode NOT IN ('solo', 'fusion', 'orchestrator', 'swarm')
       OR (mode = 'solo' AND mode_phase != 'work')
       OR (mode != 'solo' AND mode_phase = 'work');
  `)
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS run_phase_events (
      id                TEXT PRIMARY KEY,
      run_id            TEXT NOT NULL,
      mode              TEXT NOT NULL,
      phase             TEXT NOT NULL,
      phase_round       INTEGER NOT NULL,
      entered_at        TEXT NOT NULL DEFAULT (datetime('now')),
      advanced_by       TEXT,
      note              TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_run_phase_events_run
      ON run_phase_events(run_id, entered_at);
  `)
}
