import { describe, expect, it } from 'vitest'
import { unservedHostServerMessage } from './ssh-host-unserved-status'

describe('an SSH connect without a packaged server', () => {
  it('identifies the local build limitation instead of an unsupported host', () => {
    const message = unservedHostServerMessage({
      route: 'unserved',
      reason: 'orcad_unavailable',
      detail: 'artifacts_unavailable'
    })

    expect(message).toContain('This Orca build doesn’t include the server')
    expect(message).not.toContain('host isn’t supported')
    expect(message).not.toContain('older version')
  })
})
