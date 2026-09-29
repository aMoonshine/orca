import { describe, expect, it } from 'vitest'
import { desktopOrchestrationEnvelope } from './desktop-orchestration-envelope'
import { orchestrationMigrationFence } from '../runtime/rpc/orchestration-contract-fence'
import { isDurableMutation } from '../../shared/orchestration-rpc-contract'

describe('desktop orchestration requests', () => {
  it.each([
    'orchestration.runCreate',
    'orchestration.workerStart',
    'orchestration.runModeSet',
    'orchestration.runPhaseAdvance'
  ])('admits %s through the real contract fence and records it as a mutation', (method) => {
    const envelope = desktopOrchestrationEnvelope(method)
    expect(
      orchestrationMigrationFence(
        { id: 'ipc', authToken: 'ipc', method, params: {}, ...envelope },
        { runtimeId: 'runtime' }
      )
    ).toBeUndefined()
    expect(isDurableMutation(method, {})).toBe(true)
    expect(envelope?.orchestrationRequestId).toBeTruthy()
  })
  it('gives independent UI actions different mutation identities', () => {
    expect(
      desktopOrchestrationEnvelope('orchestration.workerStart')?.orchestrationRequestId
    ).not.toBe(desktopOrchestrationEnvelope('orchestration.workerStart')?.orchestrationRequestId)
  })
  it('leaves unrelated calls unchanged', () => {
    expect(desktopOrchestrationEnvelope('terminal.create')).toBeUndefined()
  })
})
