import { z } from 'zod'

import {
  firstPhaseFor,
  phaseDefinition,
  type AgentWorkMode
} from '../../../shared/swarm/mode-protocols'
import type { TuiAgent } from '../../../shared/tui-agent'

export type GroupWorker = {
  id: string
  agent: TuiAgent
  spec: string
  claims: string
  model?: string
}
export type GroupRun = { id: string; from: string; mode: AgentWorkMode; phaseId: string }
export type GroupReceipt = {
  taskId?: string
  dispatchId?: string
  state: string
  lastError?: string
  failedStage?: string
  effects?: { kind: string; role?: string; id?: string }[]
}
export type GroupTask = {
  id: string
  status: string
  spec: string
  result: string | null
  task_title?: string | null
}
export type GroupSnapshot = {
  run: GroupRun | null
  receipts: GroupReceipt[]
  tasks: GroupTask[]
  busy: boolean
  error: string | null
}
export type GroupRpc = <T>(method: string, params: unknown) => Promise<T>

const workModeSchema = z.object({
  workMode: z.object({
    mode: z.enum(['solo', 'swarm', 'fusion', 'orchestrator']),
    phaseId: z.string()
  })
})
const receiptSchema = z.object({
  taskId: z.string().optional(),
  dispatchId: z.string().optional(),
  state: z.string(),
  lastError: z.string().optional(),
  failedStage: z.string().optional(),
  effects: z
    .array(z.object({ kind: z.string(), role: z.string().optional(), id: z.string().optional() }))
    .optional()
})
const tasksSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      spec: z.string(),
      result: z.string().nullable()
    })
  )
})

export function groupPhaseWorkerLimit(mode: AgentWorkMode, phaseId: string): number {
  return mode === 'solo' ||
    phaseId === 'judge' ||
    phaseId === 'integration' ||
    phaseId === 'planning'
    ? 1
    : 6
}

export function validateGroupWave(
  mode: AgentWorkMode,
  phaseId: string,
  workers: GroupWorker[]
): void {
  const phase = phaseDefinition(mode, phaseId)
  if (!phase || workers.length < 1 || workers.length > groupPhaseWorkerLimit(mode, phaseId)) {
    throw new Error('Choose a valid number of agents for this phase.')
  }
  if (workers.some((worker) => !worker.spec.trim() || !worker.agent)) {
    throw new Error('Give every agent a task and select an installed agent.')
  }
  if (
    phase.allowsFileClaims &&
    mode !== 'solo' &&
    workers.some((worker) => !worker.claims.trim())
  ) {
    throw new Error('Assign file paths to every writer before launching this phase.')
  }
}

/** One controller per workspace survives tab changes and rejects double submissions. */
export class AgentGroupController {
  private snapshot: GroupSnapshot
  private listeners = new Set<() => void>()

  constructor(
    private rpc: GroupRpc,
    private save: (run: GroupRun | null) => void,
    run: GroupRun | null = null,
    private present: (receipts: GroupReceipt[]) => Promise<void> = async () => {}
  ) {
    this.snapshot = { run, receipts: [], tasks: [], busy: false, error: null }
  }

  getSnapshot = (): GroupSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private update(patch: Partial<GroupSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.save(this.snapshot.run)
    this.listeners.forEach((listener) => listener())
  }
  private async perform(action: () => Promise<void>): Promise<void> {
    if (this.snapshot.busy) {
      return
    }
    this.update({ busy: true, error: null })
    try {
      await action()
    } catch (error) {
      if (this.snapshot.run) {
        try {
          await this.readRun(this.snapshot.run)
        } catch {
          // Keep the original failure and last known tasks if the host is unavailable.
        }
      }
      this.update({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.update({ busy: false })
    }
  }

  private async readRun(run: GroupRun): Promise<GroupRun> {
    const current = z
      .object({ run: z.object({ id: z.string() }).nullable() })
      .parse(await this.rpc('orchestration.runCurrent', { from: run.from }))
    if (current.run?.id !== run.id) {
      throw new Error(
        'The coordinator is no longer bound to this Run. Open its terminal to inspect it.'
      )
    }
    const { workMode } = workModeSchema.parse(
      await this.rpc('orchestration.runMode', { id: run.id, from: run.from })
    )
    if (!phaseDefinition(workMode.mode, workMode.phaseId)) {
      throw new Error('Update Orca on the execution host to use this work mode.')
    }
    const updated = { ...run, ...workMode }
    this.update({ run: updated })
    const { tasks } = tasksSchema.parse(await this.rpc('orchestration.taskList', { run: run.id }))
    this.update({ tasks })
    return updated
  }

  refresh = (): Promise<void> =>
    this.perform(async () => {
      if (this.snapshot.run) {
        await this.readRun(this.snapshot.run)
      }
    })

  newGroup = (): void => {
    if (!this.snapshot.busy) {
      this.update({ run: null, receipts: [], tasks: [], error: null })
    }
  }

  launch(
    worktreeId: string,
    mode: AgentWorkMode,
    objective: string,
    workers: GroupWorker[]
  ): Promise<void> {
    return this.perform(async () => {
      let run = this.snapshot.run
      if (!objective.trim()) {
        throw new Error('Describe the goal for this group.')
      }
      validateGroupWave(run?.mode ?? mode, run?.phaseId ?? firstPhaseFor(mode).id, workers)
      if (!run) {
        const { terminal } = z.object({ terminal: z.object({ handle: z.string() }) }).parse(
          await this.rpc('terminal.create', {
            worktree: `id:${worktreeId}`,
            title: 'Agent group coordinator',
            rendererBacked: true
          })
        )
        // Keep the handle in an error receipt if Run creation fails after terminal creation.
        this.update({ receipts: [{ state: 'coordinator', lastError: terminal.handle }] })
        const created = z.object({ run: z.object({ id: z.string() }) }).parse(
          await this.rpc('orchestration.runCreate', {
            from: terminal.handle,
            objective: objective.trim(),
            mode
          })
        )
        run = { id: created.run.id, from: terminal.handle, mode, phaseId: firstPhaseFor(mode).id }
        this.update({ run })
      }
      run = await this.readRun(run)
      validateGroupWave(run.mode, run.phaseId, workers)
      this.assertSettled()
      this.update({ receipts: [] })
      for (const [index, worker] of workers.entries()) {
        const isolated = run.mode === 'orchestrator' && run.phaseId === 'implementation'
        const spec = `Goal: ${objective.trim()}\n\nTask ${index + 1} of ${workers.length}:\n${worker.spec.trim()}`
        const { task } = z.object({ task: z.object({ id: z.string() }) }).parse(
          await this.rpc('orchestration.taskCreate', {
            run: run.id,
            callerTerminalHandle: run.from,
            spec
          })
        )
        // A durable pending task blocks a duplicate wave even if the start reply is lost.
        this.update({
          tasks: [...this.snapshot.tasks, { id: task.id, status: 'pending', spec, result: null }]
        })
        const receipt = receiptSchema.parse(
          await this.rpc('orchestration.workerStart', {
            from: run.from,
            run: run.id,
            agent: worker.agent,
            ...(worker.model ? { model: worker.model } : {}),
            worktree: isolated ? 'new-child' : 'current',
            ...(isolated ? { name: `group-${run.id.slice(-8)}-${Date.now()}-${index + 1}` } : {}),
            task: task.id,
            ...(phaseDefinition(run.mode, run.phaseId)?.allowsFileClaims && worker.claims.trim()
              ? { claims: worker.claims.trim() }
              : {})
          })
        )
        this.update({ receipts: [...this.snapshot.receipts, receipt] })
        await this.present(this.snapshot.receipts)
        if (receipt.state !== 'ready') {
          throw new Error(
            receipt.lastError ??
              'Launch stopped. Inspect the recorded dispatch before starting more agents.'
          )
        }
      }
      await this.readRun(run)
    })
  }

  private assertSettled(): void {
    if (
      this.snapshot.tasks.some((task) => task.status !== 'completed' && task.status !== 'failed')
    ) {
      throw new Error(
        'Wait for every task to settle before launching another wave or advancing the phase.'
      )
    }
  }

  advance = (): Promise<void> =>
    this.perform(async () => {
      if (!this.snapshot.run) {
        return
      }
      const run = await this.readRun(this.snapshot.run)
      this.assertSettled()
      const { workMode } = workModeSchema.parse(
        await this.rpc('orchestration.runPhaseAdvance', { id: run.id, from: run.from })
      )
      this.update({ run: { ...run, ...workMode }, receipts: [] })
    })
}
