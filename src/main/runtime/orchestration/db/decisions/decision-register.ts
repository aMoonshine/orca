import type { SqliteRow } from '../../../../sqlite/sqlite-statement'
import { OrchestrationError } from '../../orchestration-error'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

/**
 * Standing decision contracts, the primitive the multi-agent modes are built on.
 *
 * A decision is not mail. Mail is consumed once from a mailbox and acknowledged; a
 * decision is re-read for the life of the Run by every peer that touches the code it
 * governs, and by an integrator that is deliberately shown the contracts without the
 * arguments that produced them. That is why these are rows and not message types:
 * a message cannot be re-read after it is acked, and adding a tenth message type would
 * mean a SQLite table rebuild to change a CHECK constraint.
 */

export type DecisionStatus = 'open' | 'frozen' | 'withdrawn'
export type DecisionStance = 'accepted' | 'objected'

export type RunDecisionRow = {
  id: string
  run_id: string
  proposed_by: string
  title: string
  contract: string
  rationale: string
  /** Workspace-relative paths the contract governs, as recorded by the proposer. */
  affects: string
  supersedes: string | null
  status: DecisionStatus
  frozen_at: string | null
  created_at: string
  updated_at: string
}

export type DecisionResponseRow = {
  decision_id: string
  dispatch_id: string
  stance: DecisionStance
  note: string
  created_at: string
  updated_at: string
}

export type DecisionSummary = {
  decision: RunDecisionRow
  /** Paths parsed from the stored JSON, so a caller never parses the column itself. */
  affects: string[]
  objectingDispatches: string[]
  respondedDispatches: string[]
}

/**
 * Why narrowers rather than a cast per call site: every query is `SELECT *` against
 * tables this file's schema declares, and the driver returns untyped records by
 * design — the same invariant `file-claim-store.ts` documents.
 */
function toDecisionRows(rows: SqliteRow[]): RunDecisionRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over run_decisions returns the columns this file's schema declares, and RunDecisionRow names each of them.
  return rows as RunDecisionRow[]
}

function toDecisionRow(row: SqliteRow | undefined): RunDecisionRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same SELECT * invariant as toDecisionRows, narrowed for the single-row lookup.
  return row as RunDecisionRow | undefined
}

function toResponseRows(rows: SqliteRow[]): DecisionResponseRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over decision_responses returns the columns this file's schema declares, and DecisionResponseRow names each of them.
  return rows as DecisionResponseRow[]
}

function parseAffects(affects: string): string[] {
  try {
    const parsed: unknown = JSON.parse(affects)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    // A malformed column must not hide the contract it travels with; the text is
    // the contract, and an unreadable path list degrades to "governs nothing".
    return []
  }
}

function summarize(row: RunDecisionRow, responses: DecisionResponseRow[]): DecisionSummary {
  return {
    decision: row,
    affects: parseAffects(row.affects),
    objectingDispatches: responses
      .filter((response) => response.stance === 'objected')
      .map((response) => response.dispatch_id),
    respondedDispatches: responses.map((response) => response.dispatch_id)
  }
}

function readResponses(this: OrchestrationDb, decisionId: string): DecisionResponseRow[] {
  return toResponseRows(
    this.db
      .prepare('SELECT * FROM decision_responses WHERE decision_id = ? ORDER BY created_at')
      .all(decisionId)
  )
}

/**
 * Publish a contract on behalf of every peer in the Run.
 *
 * Why `open` and not immediately binding: the spec's protocol is coordination first,
 * then a bounded catch-up, and freezing inside propose would make a contract that no
 * peer could object to. A superseding proposal is the only way to change a frozen
 * contract, so peers that already built against the old one can see what replaced it.
 */
export function proposeDecision(
  this: OrchestrationDb,
  params: {
    runId: string
    proposedBy: string
    title: string
    contract: string
    rationale?: string
    affects?: readonly string[]
    supersedes?: string
  }
): DecisionSummary {
  const title = params.title.trim()
  const contract = params.contract.trim()
  if (title.length === 0 || contract.length === 0) {
    throw new OrchestrationError(
      'invalid_argument',
      'A decision needs both a title and a contract body.'
    )
  }
  if (params.supersedes) {
    const prior = toDecisionRow(
      this.db.prepare('SELECT * FROM run_decisions WHERE id = ?').get(params.supersedes)
    )
    if (!prior || prior.run_id !== params.runId) {
      throw new OrchestrationError(
        'decision_not_found',
        `Decision ${params.supersedes} was not found in Run ${params.runId}.`
      )
    }
  }

  this.db.exec('BEGIN IMMEDIATE')
  try {
    const id = generateId('dec')
    this.db
      .prepare(
        `INSERT INTO run_decisions
           (id, run_id, proposed_by, title, contract, rationale, affects, supersedes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.runId,
        params.proposedBy,
        title,
        contract,
        params.rationale ?? '',
        JSON.stringify([...(params.affects ?? [])]),
        params.supersedes ?? null
      )
    const row = toDecisionRow(this.db.prepare('SELECT * FROM run_decisions WHERE id = ?').get(id))
    this.db.exec('COMMIT')
    if (!row) {
      throw new Error(`Decision ${id} was not readable immediately after insert.`)
    }
    return summarize(row, [])
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Record a peer's answer to one contract.
 *
 * Why an objection must carry a reason: the spec's noise filter exists so a message
 * always says something. A silent objection is indistinguishable from a lost message
 * and blocks the freeze with no way to resolve it, so it is refused here rather than
 * accepted and then ignored by whoever reads the list.
 */
export function acknowledgeDecision(
  this: OrchestrationDb,
  params: { decisionId: string; dispatchId: string; stance: DecisionStance; note?: string }
): DecisionSummary {
  const note = params.note?.trim() ?? ''
  if (params.stance === 'objected' && note.length === 0) {
    throw new OrchestrationError(
      'invalid_argument',
      'An objection must say why: a bare objection cannot be resolved by the proposer.'
    )
  }
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const row = toDecisionRow(
      this.db.prepare('SELECT * FROM run_decisions WHERE id = ?').get(params.decisionId)
    )
    if (!row) {
      throw new OrchestrationError(
        'decision_not_found',
        `Decision ${params.decisionId} was not found.`
      )
    }
    if (row.status === 'frozen') {
      throw new OrchestrationError(
        'decision_frozen',
        `Decision ${params.decisionId} is frozen; propose a superseding decision instead of objecting.`
      )
    }
    this.db
      .prepare(
        `INSERT INTO decision_responses (decision_id, dispatch_id, stance, note)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(decision_id, dispatch_id) DO UPDATE SET
           stance = excluded.stance,
           note = excluded.note,
           updated_at = datetime('now')`
      )
      .run(params.decisionId, params.dispatchId, params.stance, note)
    const responses = readResponses.call(this, params.decisionId)
    this.db.exec('COMMIT')
    return summarize(row, responses)
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Make the Run's open contracts binding.
 *
 * Why this refuses while an objection is open: freezing an object-to'd contract is
 * the exact silent-override the spec's noise filter is guarding against — the
 * proposer gets its way because the objection was easy to skim past. The proposer
 * resolves it by superseding, which is visible.
 */
export function freezeDecisions(this: OrchestrationDb, params: { runId: string }): string[] {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const open = toDecisionRows(
      this.db
        .prepare("SELECT * FROM run_decisions WHERE run_id = ? AND status = 'open' ORDER BY id")
        .all(params.runId)
    )
    const blocked: string[] = []
    for (const decision of open) {
      const objection = readResponses
        .call(this, decision.id)
        .find((response) => response.stance === 'objected')
      if (objection) {
        blocked.push(`${decision.id} (objected by ${objection.dispatch_id})`)
      }
    }
    if (blocked.length > 0) {
      throw new OrchestrationError(
        'decision_objection_open',
        `Cannot freeze ${blocked.length} decision(s) with an unresolved objection: ${blocked.join(', ')}.`,
        { blocked }
      )
    }
    this.db
      .prepare(
        `UPDATE run_decisions
         SET status = 'frozen', frozen_at = datetime('now'), updated_at = datetime('now')
         WHERE run_id = ? AND status = 'open'`
      )
      .run(params.runId)
    this.db.exec('COMMIT')
    return open.map((decision) => decision.id)
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function withdrawDecision(this: OrchestrationDb, decisionId: string): void {
  this.db
    .prepare(
      `UPDATE run_decisions
       SET status = 'withdrawn', updated_at = datetime('now')
       WHERE id = ? AND status = 'open'`
    )
    .run(decisionId)
}

/**
 * The contract register: what an integrator is meant to read.
 *
 * Withdrawn rows are dropped because a withdrawn contract is not a contract, and the
 * one reader this serves cannot tell a withdrawal from a decision unless it is gone.
 */
export function listDecisions(
  this: OrchestrationDb,
  params: { runId: string; status?: DecisionStatus }
): DecisionSummary[] {
  const rows =
    params.status === undefined
      ? this.db
          .prepare(
            "SELECT * FROM run_decisions WHERE run_id = ? AND status != 'withdrawn' ORDER BY id"
          )
          .all(params.runId)
      : this.db
          .prepare('SELECT * FROM run_decisions WHERE run_id = ? AND status = ? ORDER BY id')
          .all(params.runId, params.status)
  return toDecisionRows(rows).map((row) => summarize(row, readResponses.call(this, row.id)))
}

/** Contracts this worker has not answered, which is the spec's catch-up phase input. */
export function listUnansweredDecisions(
  this: OrchestrationDb,
  params: { runId: string; dispatchId: string }
): DecisionSummary[] {
  // Joined rather than filtered in JS: the responses table keys on decision id alone,
  // so without the join a response to a decision in another Run would silently
  // suppress this Run's unanswered one.
  const answered = new Set(
    toResponseRows(
      this.db
        .prepare(
          `SELECT r.decision_id
           FROM decision_responses r
           JOIN run_decisions d ON d.id = r.decision_id
           WHERE r.dispatch_id = ? AND d.run_id = ?`
        )
        .all(params.dispatchId, params.runId)
    ).map((response) => response.decision_id)
  )
  return listDecisions
    .call(this, { runId: params.runId, status: 'open' })
    .filter((entry) => !answered.has(entry.decision.id))
}

export type DecisionRegisterMethods = {
  proposeDecision: typeof proposeDecision
  acknowledgeDecision: typeof acknowledgeDecision
  freezeDecisions: typeof freezeDecisions
  withdrawDecision: typeof withdrawDecision
  listDecisions: typeof listDecisions
  listUnansweredDecisions: typeof listUnansweredDecisions
}

export function attachDecisionRegister(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    proposeDecision,
    acknowledgeDecision,
    freezeDecisions,
    withdrawDecision,
    listDecisions,
    listUnansweredDecisions
  })
}
