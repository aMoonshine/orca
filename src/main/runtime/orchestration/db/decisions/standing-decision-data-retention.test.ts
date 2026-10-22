import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SqliteRow } from '../../../../sqlite/sqlite-statement'
import { OrchestrationDb } from '../../db'
import { SCHEMA_VERSION } from '../contract-constants'

describe('historical standing-decision data', () => {
  it.each([43, 44, 45, SCHEMA_VERSION])(
    'preserves decision history and responses when opening and reopening a v%i profile',
    (version) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-standing-decision-retention-'))
      const path = join(directory, 'orchestration.db')
      try {
        const original = new OrchestrationDb(path)
        let decisions: SqliteRow[]
        let responses: SqliteRow[]
        try {
          original.db.exec(`
            INSERT INTO run_decisions
              (id, run_id, proposed_by, title, contract, rationale, affects, status, frozen_at)
            VALUES
              ('dec_original', 'run_legacy_local', 'dispatch_a', 'Interface', 'Keep this contract',
               'Keep this rationale', '["src/interface.ts"]', 'frozen', '2026-10-01 12:00:00');
            INSERT INTO run_decisions
              (id, run_id, proposed_by, title, contract, supersedes, status)
            VALUES
              ('dec_replacement', 'run_legacy_local', 'dispatch_b', 'Replacement',
               'Keep this withdrawn proposal', 'dec_original', 'withdrawn');
            INSERT INTO decision_responses (decision_id, dispatch_id, stance, note)
            VALUES
              ('dec_original', 'dispatch_b', 'accepted', 'Keep this acceptance'),
              ('dec_replacement', 'dispatch_a', 'objected', 'Keep this objection');
          `)
          decisions = original.db.prepare('SELECT * FROM run_decisions ORDER BY id').all()
          responses = original.db
            .prepare('SELECT * FROM decision_responses ORDER BY decision_id, dispatch_id')
            .all()
          original.db.pragma(`user_version = ${version}`)
        } finally {
          original.close()
        }

        for (const opening of ['migration', 'reopen']) {
          const db = new OrchestrationDb(path)
          try {
            expect(db.db.pragma('user_version', { simple: true }), opening).toBe(SCHEMA_VERSION)
            expect(db.db.prepare('SELECT * FROM run_decisions ORDER BY id').all(), opening).toEqual(
              decisions
            )
            expect(
              db.db
                .prepare('SELECT * FROM decision_responses ORDER BY decision_id, dispatch_id')
                .all(),
              opening
            ).toEqual(responses)
          } finally {
            db.close()
          }
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
})
