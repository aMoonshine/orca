import { describe, expect, it } from 'vitest'
import { OrchestrationError } from '../../orchestration-error'
import { OrchestrationDb } from '../../db'

/**
 * The Swarm contract primitive, per agent-to-agent.md §3: a peer that designs a
 * signature, interface or schema publishes a decision that becomes a binding contract
 * for everyone else. These pin the three properties the mode depends on — a peer can
 * object, an objection blocks, and a frozen contract can only change by superseding.
 */
describe('decision register', () => {
  function newDb(): OrchestrationDb {
    return new OrchestrationDb(':memory:')
  }

  const RUN = 'run_legacy_local'

  it('publishes a contract with the paths it governs', () => {
    const db = newDb()
    const proposed = db.proposeDecision({
      runId: RUN,
      proposedBy: 'dispatch_a',
      title: 'parseTokens signature',
      contract: 'function parseTokens(input: string): Token[]',
      rationale: 'A single entry point keeps the lexer and parser consistent.',
      affects: ['src/parser/token.ts', 'src/parser/lexer.ts']
    })

    expect(proposed.decision.status).toBe('open')
    expect(proposed.affects).toEqual(['src/parser/token.ts', 'src/parser/lexer.ts'])
    expect(proposed.decision.contract).toContain('parseTokens')
    db.close()
  })

  it('refuses an empty contract, which is the noise filter applied where it matters', () => {
    const db = newDb()
    expect(() =>
      db.proposeDecision({ runId: RUN, proposedBy: 'dispatch_a', title: 'x', contract: '  ' })
    ).toThrow(/both a title and a contract body/)
    db.close()
  })

  it('refuses a bare objection with nothing to resolve', () => {
    const db = newDb()
    const proposed = db.proposeDecision({
      runId: RUN,
      proposedBy: 'dispatch_a',
      title: 'parseTokens signature',
      contract: 'function parseTokens(input: string): Token[]'
    })

    expect(() =>
      db.acknowledgeDecision({
        decisionId: proposed.decision.id,
        dispatchId: 'dispatch_b',
        stance: 'objected'
      })
    ).toThrow(OrchestrationError)

    const accepted = db.acknowledgeDecision({
      decisionId: proposed.decision.id,
      dispatchId: 'dispatch_b',
      stance: 'accepted'
    })
    expect(accepted.respondedDispatches).toEqual(['dispatch_b'])
    db.close()
  })

  it('names the peer that objected instead of freezing over it', () => {
    const db = newDb()
    const proposed = db.proposeDecision({
      runId: RUN,
      proposedBy: 'dispatch_a',
      title: 'parseTokens signature',
      contract: 'function parseTokens(input: string): Token[]'
    })
    db.acknowledgeDecision({
      decisionId: proposed.decision.id,
      dispatchId: 'dispatch_b',
      stance: 'objected',
      note: 'This hides the offset the error reporter needs.'
    })

    let caught: OrchestrationError | undefined
    try {
      db.freezeDecisions({ runId: RUN })
    } catch (error) {
      if (error instanceof OrchestrationError) {
        caught = error
      }
    }
    expect(caught?.code).toBe('decision_objection_open')
    expect(caught?.message).toContain('dispatch_b')
    expect(db.listDecisions({ runId: RUN, status: 'open' })).toHaveLength(1)
    db.close()
  })

  it('freezes a contract once every peer has had its say', () => {
    const db = newDb()
    const proposed = db.proposeDecision({
      runId: RUN,
      proposedBy: 'dispatch_a',
      title: 'parseTokens signature',
      contract: 'function parseTokens(input: string): Token[]'
    })
    db.acknowledgeDecision({
      decisionId: proposed.decision.id,
      dispatchId: 'dispatch_b',
      stance: 'accepted'
    })

    expect(db.freezeDecisions({ runId: RUN })).toEqual([proposed.decision.id])
    const frozen = db.listDecisions({ runId: RUN })
    expect(frozen).toHaveLength(1)
    expect(frozen[0].decision.status).toBe('frozen')
    expect(frozen[0].decision.frozen_at).not.toBeNull()
    db.close()
  })

  it('will not let a peer object to a frozen contract; it must supersede it', () => {
    const db = newDb()
    const proposed = db.proposeDecision({
      runId: RUN,
      proposedBy: 'dispatch_a',
      title: 'parseTokens signature',
      contract: 'function parseTokens(input: string): Token[]'
    })
    db.freezeDecisions({ runId: RUN })

    let caught: OrchestrationError | undefined
    try {
      db.acknowledgeDecision({
        decisionId: proposed.decision.id,
        dispatchId: 'dispatch_b',
        stance: 'objected',
        note: 'Too late?'
      })
    } catch (error) {
      if (error instanceof OrchestrationError) {
        caught = error
      }
    }
    expect(caught?.code).toBe('decision_frozen')

    const replacement = db.proposeDecision({
      runId: RUN,
      proposedBy: 'dispatch_b',
      title: 'parseTokens signature',
      contract: 'function parseTokens(input: string, offset: number): Token[]',
      supersedes: proposed.decision.id
    })
    expect(replacement.decision.supersedes).toBe(proposed.decision.id)
    db.close()
  })

  it('tells a peer what it still owes an answer to, which is the catch-up phase', () => {
    const db = newDb()
    const first = db.proposeDecision({
      runId: RUN,
      proposedBy: 'dispatch_a',
      title: 'parseTokens signature',
      contract: 'function parseTokens(input: string): Token[]'
    })
    db.acknowledgeDecision({
      decisionId: first.decision.id,
      dispatchId: 'dispatch_b',
      stance: 'accepted'
    })
    db.proposeDecision({
      runId: RUN,
      proposedBy: 'dispatch_c',
      title: 'Token shape',
      contract: 'interface Token { kind: TokenKind; value: string }'
    })

    // By title, not by index: decision ids are random, and the register orders by id,
    // so position is not stable across runs.
    const owed = db.listUnansweredDecisions({ runId: RUN, dispatchId: 'dispatch_b' })
    expect(owed.map((entry) => entry.decision.title)).toEqual(['Token shape'])
    db.close()
  })

  it('keeps Runs apart', () => {
    const db = newDb()
    db.proposeDecision({
      runId: RUN,
      proposedBy: 'dispatch_a',
      title: 'A',
      contract: 'contract A'
    })
    db.proposeDecision({ runId: 'run_other', proposedBy: 'dispatch_x', title: 'B', contract: 'b' })

    expect(db.listDecisions({ runId: RUN })).toHaveLength(1)
    expect(db.listDecisions({ runId: 'run_other' })).toHaveLength(1)
    // Freezing one Run must not freeze the other's contracts.
    db.freezeDecisions({ runId: RUN })
    expect(db.listDecisions({ runId: 'run_other', status: 'open' })).toHaveLength(1)
    db.close()
  })

  it('drops a withdrawn contract from the register', () => {
    const db = newDb()
    const proposed = db.proposeDecision({
      runId: RUN,
      proposedBy: 'dispatch_a',
      title: 'Wrong idea',
      contract: 'contract A'
    })
    db.withdrawDecision(proposed.decision.id)

    expect(db.listDecisions({ runId: RUN })).toHaveLength(0)
    db.close()
  })
})
