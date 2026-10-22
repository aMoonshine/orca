import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

const historySchema = z.object({
  messages: z.array(z.object({ id: z.string(), type: z.string() })),
  pendingQuestions: z.array(z.object({ id: z.string() }))
})

describe('Run pending questions in read-only history', () => {
  const h = createOrchestrationRpcHarness()
  afterEach(() => h.cleanup())

  it('retains acknowledged unanswered questions beyond 100 heartbeats without changing FIFO', async () => {
    const { db, ctx, activeRunId } = h.setup()
    if (!activeRunId) {
      throw new Error('Expected a bound Run')
    }
    const task = db.createTask({ spec: 'ask for direction' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    const ask = (dispatchId = dispatch.id) =>
      db.createQuestion({
        runId: activeRunId,
        dispatchId,
        askerHandle: 'term_worker',
        question: 'Proceed?'
      }).message
    const pending = ask()
    const answered = ask()
    const closedTask = db.createTask({ spec: 'closed question' })
    const closedDispatch = createRootDispatch(db, closedTask.id, 'term_closed_worker')
    ask(closedDispatch.id)
    db.answerQuestion({
      messageId: answered.id,
      runId: activeRunId,
      consumerGeneration: 1,
      body: 'Yes'
    })
    const delivery = db.getOrCreateRunDelivery({ runId: activeRunId, consumerGeneration: 1 })
    if (!delivery) {
      throw new Error('Expected question delivery')
    }
    db.acknowledgeRunDelivery({
      runId: activeRunId,
      consumerGeneration: 1,
      deliveryId: delivery.delivery.id
    })
    db.closeQuestionsForDispatch(closedDispatch.id)
    for (let index = 0; index < 105; index++) {
      db.insertMessage({
        from: 'term_worker',
        to: `run:${activeRunId}`,
        type: 'heartbeat',
        subject: 'alive'
      })
    }
    const check = (params: Record<string, unknown> = {}) =>
      h.call(
        'orchestration.check',
        { terminal: 'term_coord', run: activeRunId, all: true, ...params },
        ctx
      )
    const history = historySchema.parse(await check())
    expect(history.messages).toHaveLength(100)
    expect(history.messages.every((message) => message.type === 'heartbeat')).toBe(true)
    expect(history.pendingQuestions).toEqual([{ id: pending.id }])
    expect(db.getMessageById(pending.id)?.read).toBe(1)
    expect(db.hasOutstandingMailboxDelivery(`run:${activeRunId}`)).toBe(false)
    const fifo = db.getOrCreateRunDelivery({ runId: activeRunId, consumerGeneration: 1 })
    expect(fifo?.messages.length).toBeGreaterThan(0)
    await check()
    expect(
      db.getOrCreateRunDelivery({ runId: activeRunId, consumerGeneration: 1 })?.delivery.id
    ).toBe(fifo?.delivery.id)
    expect(historySchema.parse(await check({ types: 'heartbeat' })).pendingQuestions).toEqual([])
    db.answerQuestion({
      messageId: pending.id,
      runId: activeRunId,
      consumerGeneration: 1,
      body: 'Proceed'
    })
    expect(historySchema.parse(await check()).pendingQuestions).toEqual([])
  })

  it('rejects unauthorized Run history and excludes another Run questions', async () => {
    const { db, ctx, activeRunId } = h.setup()
    if (!activeRunId) {
      throw new Error('Expected a bound Run')
    }
    const other = db.createRun({
      objective: 'other',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'other:pane'
    })
    const task = db.createTask({ spec: 'other question', runId: other.id })
    const dispatch = createRootDispatch(db, task.id, 'term_other_worker')
    db.createQuestion({
      runId: other.id,
      dispatchId: dispatch.id,
      askerHandle: 'term_other_worker',
      question: 'Private?'
    })
    const result = await h.call(
      'orchestration.check',
      { terminal: 'term_coord', run: activeRunId, all: true },
      ctx
    )
    expect(historySchema.parse(result).pendingQuestions).toEqual([])
    await expect(
      h.call('orchestration.check', { terminal: 'term_coord', run: other.id, all: true }, ctx)
    ).rejects.toThrow()
  })
})
