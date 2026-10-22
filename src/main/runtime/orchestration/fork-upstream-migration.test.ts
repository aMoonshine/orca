import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'

describe('fork and upstream schema convergence', () => {
  it('preserves fork modes and claims while migrating old session addresses', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      db.db.exec(`
        UPDATE runs SET mode = 'swarm', mode_phase = 'coordination'
        WHERE id = 'run_legacy_local';
        INSERT INTO worker_file_claims (run_id, workspace_id, claim_key, display_path, dispatch_id)
        VALUES ('run_legacy_local', 'workspace', 'src/a.ts', 'src/a.ts', 'dispatch');
      `)
      const message = db.insertMessage({
        runId: 'run_legacy_local',
        from: 'session:old',
        to: 'term_a',
        subject: 'report',
        body: 'preserve this'
      })
      db.db.pragma('user_version = 45')
      db.migrate()
      expect(
        db.db.prepare('SELECT from_handle, body FROM messages WHERE id = ?').get(message.id)
      ).toEqual({ from_handle: 'orca_session_id:old', body: 'preserve this' })
      expect(db.getRunWorkMode('run_legacy_local').mode).toBe('swarm')
      expect(db.db.prepare('SELECT dispatch_id FROM worker_file_claims').get()).toEqual({
        dispatch_id: 'dispatch'
      })
      expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })

  it('adds fork tables and modes to an upstream v43 database', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      db.db.exec(`
        DROP TABLE worker_file_claims;
        DROP TABLE decision_responses;
        DROP TABLE run_decisions;
        DROP TABLE run_phase_events;
        ALTER TABLE runs DROP COLUMN mode;
        ALTER TABLE runs DROP COLUMN mode_phase;
        ALTER TABLE runs DROP COLUMN mode_phase_round;
      `)
      db.db.pragma('user_version = 43')
      db.migrate()
      expect(db.getRunWorkMode('run_legacy_local').mode).toBe('solo')
      expect(db.db.prepare('SELECT * FROM worker_file_claims').all()).toEqual([])
      expect(db.db.prepare('SELECT * FROM run_decisions').all()).toEqual([])
      db.migrate()
      expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })
})
