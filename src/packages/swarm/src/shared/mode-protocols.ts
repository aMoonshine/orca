// Modes belong to a Run. Claim admission is enforced; editing limits remain agent instructions.

export type AgentWorkMode = 'solo' | 'fusion' | 'orchestrator' | 'swarm'

export const AGENT_WORK_MODES: readonly AgentWorkMode[] = [
  'solo',
  'fusion',
  'orchestrator',
  'swarm'
]

// Widened to string so the membership test needs no cast at the call site.
const AGENT_WORK_MODE_SET: ReadonlySet<string> = new Set(AGENT_WORK_MODES)

export function isAgentWorkMode(value: unknown): value is AgentWorkMode {
  return typeof value === 'string' && AGENT_WORK_MODE_SET.has(value)
}

export type ModePhase = {
  id: string
  /** Shown in the coordinator UI and used in messages, so it must read as prose. */
  label: string
  /** Allows ownership claims in this phase; it does not sandbox filesystem writes. */
  allowsFileClaims: boolean
  /** Advisory discussion flag retained in serialized phases for older clients. */
  allowsDecisions: boolean
  /**
   * Bounded re-entries, the spec's "round limit (2-3)" that stops two agents debating
   * forever. Null means the phase is entered once and not repeated.
   */
  maxRounds: number | null
  /** One line the preamble shows the worker, so the protocol is visible in the terminal. */
  instruction: string
}

export type ModeDefinition = {
  mode: AgentWorkMode
  label: string
  /** Why this mode exists, in the words of the spec it implements. */
  summary: string
  phases: readonly ModePhase[]
}

const COORDINATION_PHASE = (mode: AgentWorkMode): ModePhase => ({
  id: 'coordination',
  label: 'Coordination',
  allowsFileClaims: false,
  allowsDecisions: true,
  maxRounds: null,
  instruction:
    mode === 'swarm'
      ? 'Do not edit any file. Read the repository, agree ownership and interfaces with the coordinator, and record them in the work order. Stay silent if you have nothing to add.'
      : 'Do not edit any file. Read the code and give the coordinator a plan and the interfaces the workers must follow.'
})

const IMPLEMENTATION_PHASE = (mode: AgentWorkMode): ModePhase => ({
  id: 'implementation',
  label: 'Implementation',
  allowsFileClaims: true,
  allowsDecisions: true,
  maxRounds: null,
  instruction:
    mode === 'fusion'
      ? 'Implement the work order exactly. If the project contradicts it, stop and report the deviation instead of improvising.'
      : 'Write code only inside the paths you claimed and follow the work order agreed with the coordinator. Report interface changes before proceeding.'
})

const CATCHUP_PHASE: ModePhase = {
  id: 'catchup',
  label: 'Catch-up',
  allowsFileClaims: true,
  allowsDecisions: true,
  // The spec's round limit. Two rounds are enough to absorb a contract that landed
  // mid-generation; more than that is debate, not work.
  maxRounds: 2,
  instruction:
    'Read the coordinator updates that arrived while you were working, adjust your own code to the agreed work order, then stop. Do not open a new round of debate.'
}

const PANEL_PHASE: ModePhase = {
  id: 'panel',
  label: 'Panel',
  // The spec is explicit: the panel is read-only, and isolation between panelists is
  // what stops them converging on one confident wrong answer.
  allowsFileClaims: false,
  allowsDecisions: false,
  maxRounds: null,
  instruction:
    'You are one of several independent reviewers. Do not read any other reviewer and do not write any file. Report your proposal, your reasoning, the files it touches, its risks, and what must not be done.'
}

const JUDGE_PHASE: ModePhase = {
  id: 'judge',
  label: 'Judge',
  // The judge writes the work order, never the code.
  allowsFileClaims: false,
  allowsDecisions: true,
  maxRounds: null,
  instruction:
    'Do not write an answer from scratch. Compare the panels on agreement, contradiction, unique findings, unique architecture, and blind spots, then give the coordinator a work order for the integrator.'
}

const INTEGRATOR_PHASE: ModePhase = {
  id: 'integration',
  label: 'Integration',
  allowsFileClaims: true,
  allowsDecisions: true,
  maxRounds: null,
  instruction:
    'You are the only writer. Implement the work order agreed with the coordinator and report every place the project forced you to deviate.'
}

const PLANNING_PHASE: ModePhase = {
  id: 'planning',
  label: 'Planning',
  // Nobody touches the target before the task is split; each worker's worktree is
  // created from the plan, not from whatever the last one left behind.
  allowsFileClaims: false,
  allowsDecisions: true,
  maxRounds: null,
  instruction:
    'Do not write any file. Split the work into independent units with disjoint file ownership and record their interfaces in the work order for the coordinator.'
}

const SOLO_PHASES: readonly ModePhase[] = [
  {
    id: 'work',
    label: 'Work',
    allowsFileClaims: true,
    allowsDecisions: false,
    maxRounds: null,
    instruction: 'Do the task and report the outcome once, when it is done.'
  }
]

export const MODE_PROTOCOLS: Record<AgentWorkMode, ModeDefinition> = {
  solo: {
    mode: 'solo',
    label: 'Solo',
    summary: 'One agent on an isolated, well-understood task.',
    phases: SOLO_PHASES
  },
  swarm: {
    mode: 'swarm',
    label: 'Swarm',
    summary:
      'Workers share a workspace with disjoint file ownership and follow interfaces agreed with the coordinator.',
    phases: [COORDINATION_PHASE('swarm'), IMPLEMENTATION_PHASE('swarm'), CATCHUP_PHASE]
  },
  fusion: {
    mode: 'fusion',
    label: 'Fusion',
    summary:
      'Independent read-only reviewers, then a judge who proposes a work order, then a single integrator.',
    phases: [PANEL_PHASE, JUDGE_PHASE, INTEGRATOR_PHASE]
  },
  orchestrator: {
    mode: 'orchestrator',
    label: 'Orchestrator',
    summary:
      'A planner splits the work into units with disjoint file ownership; each worker gets its own worktree; an integrator merges.',
    phases: [PLANNING_PHASE, IMPLEMENTATION_PHASE('orchestrator'), INTEGRATOR_PHASE]
  }
}

export function firstPhaseFor(mode: AgentWorkMode): ModePhase {
  return MODE_PROTOCOLS[mode].phases[0]
}

export function phaseDefinition(mode: AgentWorkMode, phaseId: string): ModePhase | undefined {
  return MODE_PROTOCOLS[mode].phases.find((phase) => phase.id === phaseId)
}

/** The phase after `phaseId`, or undefined at the end of the protocol. */
export function nextPhaseFor(mode: AgentWorkMode, phaseId: string): ModePhase | undefined {
  const phases = MODE_PROTOCOLS[mode].phases
  const index = phases.findIndex((phase) => phase.id === phaseId)
  return index === -1 ? undefined : phases[index + 1]
}

/**
 * Whether another round is allowed in a phase.
 *
 * Why rounds are counted per phase rather than per Run: the spec's limit exists
 * specifically to stop the catch-up debate, and a Run-wide counter would be spent by
 * whatever phase happened to run first.
 */
export function phaseAllowsAnotherRound(phase: ModePhase, roundsTaken: number): boolean {
  if (phase.maxRounds === null) {
    return false
  }
  return roundsTaken < phase.maxRounds
}
