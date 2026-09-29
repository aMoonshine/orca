import { randomUUID } from 'node:crypto'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'

export function desktopOrchestrationEnvelope(
  method: string
): RuntimeOrchestrationEnvelope | undefined {
  if (!method.startsWith('orchestration.')) {
    return undefined
  }
  return {
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: randomUUID()
  }
}
