import { describe, expect, it } from 'vitest'
import type { TabAgentLaunchOption } from '@/components/tab-bar/tab-agent-launch-options'
import type { GroupWorker } from './agent-group-launch'
import { groupWorkerCanLaunch } from './agent-group-provider-options'

const options: TabAgentLaunchOption[] = [
  { agent: 'codex', label: 'Codex', aliases: [] },
  { agent: 'opencode', label: 'OpenCode', aliases: [] },
  { agent: 'gemini', label: 'Gemini', aliases: [] }
]
const worker: GroupWorker = { id: 'worker', agent: 'codex', spec: 'Review', claims: '' }

describe('agent group launch eligibility', () => {
  it('accepts exact models with explicit supported effort and omitted defaults', () => {
    expect(groupWorkerCanLaunch({ ...worker, model: 'gpt-6.1-sol', effort: 'high' }, options)).toBe(
      true
    )
    expect(groupWorkerCanLaunch({ ...worker, model: 'gpt-6.1-sol' }, options)).toBe(true)
    expect(
      groupWorkerCanLaunch({ ...worker, agent: 'opencode', model: 'opencode/big-pickle' }, options)
    ).toBe(true)
    expect(groupWorkerCanLaunch({ ...worker, agent: 'gemini', model: '' }, options)).toBe(true)
  })

  const invalidChoices: GroupWorker[] = [
    { ...worker, model: 'gpt-6.1-sol', effort: 'invalid' },
    { ...worker, effort: 'high' },
    { ...worker, agent: 'opencode', model: 'opencode/big-pickle', effort: 'high' },
    { ...worker, agent: 'gemini', model: '', effort: 'high' },
    { ...worker, agent: 'gemini', model: 'explicit-model' }
  ]
  it.each(invalidChoices)('rejects unsupported $agent/$model/$effort selections', (choice) => {
    expect(groupWorkerCanLaunch(choice, options)).toBe(false)
  })

  it('still requires an available provider and an exact model for preference-capable providers', () => {
    expect(groupWorkerCanLaunch(worker, options)).toBe(false)
    expect(groupWorkerCanLaunch({ ...worker, model: 'gpt-6.1-sol', effort: 'high' }, [])).toBe(
      false
    )
    expect(
      groupWorkerCanLaunch({ ...worker, model: 'gpt-6.1-sol', effort: 'high' }, [
        { ...options[0], disabled: true }
      ])
    ).toBe(false)
  })
})
