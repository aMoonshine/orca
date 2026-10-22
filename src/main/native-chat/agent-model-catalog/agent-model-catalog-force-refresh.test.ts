import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import {
  createAgentModelCatalogService,
  type AgentModelCatalogService
} from './agent-model-catalog-service'
import {
  AgentModelCatalogStore,
  type AgentModelCatalogProbe,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

const services: AgentModelCatalogService[] = []
afterEach(() => services.splice(0).forEach((service) => service.stop()))

function listing(id: string): AgentModelCatalogSuccess {
  return {
    origin: 'probe',
    complete: true,
    models: [{ id, label: id, isDefault: true, efforts: [] }]
  }
}

function harness() {
  let account = '/account-one'
  let command = 'first-cli'
  let installed = 'first'
  let offline = false
  const run = vi.fn(async () => {
    if (offline) {
      throw new Error('offline')
    }
    return listing(installed)
  })
  const probe: AgentModelCatalogProbe = Object.assign(async () => run(), {
    resolve: async (_home: AgentSessionAccountHome, cwd: string) => ({
      identity: { command, cwd },
      run
    })
  })
  const service = createAgentModelCatalogService({
    store: new AgentModelCatalogStore({ now: () => 1000 }),
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: account }),
    probes: { codex: probe }
  })
  services.push(service)
  return {
    service,
    run,
    account: (value: string) => {
      account = value
    },
    command: (value: string) => {
      command = value
    },
    installed: (value: string) => {
      installed = value
    },
    offline: (value: boolean) => {
      offline = value
    },
    read: (options: { forceRefresh?: boolean; workspacePath?: string; savedOnly?: boolean } = {}) =>
      service.read({ agent: 'codex', workspacePath: '/project', waitForListing: true, ...options })
  }
}

describe('explicit catalog refresh', () => {
  it('re-probes a fresh two-minute entry and waits for its replacement', async () => {
    const h = harness()
    await h.read()
    h.installed('new')
    expect(await h.read()).toMatchObject({ models: [{ id: 'first' }] })
    expect(await h.read({ forceRefresh: true })).toMatchObject({ models: [{ id: 'new' }] })
    expect(h.run).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])(
    'bypasses a fresh failure TTL with a previous entry: %s',
    async (saved) => {
      const h = harness()
      if (saved) {
        await h.read()
      }
      h.offline(true)
      await h.read({ forceRefresh: true })
      const failedAttempts = h.run.mock.calls.length
      h.offline(false)
      h.installed('recovered')
      await h.read()
      expect(h.run).toHaveBeenCalledTimes(failedAttempts)
      expect(await h.read({ forceRefresh: true })).toMatchObject({ models: [{ id: 'recovered' }] })
      expect(h.run).toHaveBeenCalledTimes(failedAttempts + 1)
    }
  )

  it('joins concurrent refreshes and holds every caller until the one probe finishes', async () => {
    const h = harness()
    await h.read()
    let finish: ((value: AgentModelCatalogSuccess) => void) | undefined
    h.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    let completed = 0
    const first = h.read({ forceRefresh: true }).then((result) => {
      completed++
      return result
    })
    const second = h.read({ forceRefresh: true }).then((result) => {
      completed++
      return result
    })
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2))
    expect(completed).toBe(0)
    finish?.(listing('joined'))
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ models: [expect.objectContaining({ id: 'joined' })] }),
      expect.objectContaining({ models: [expect.objectContaining({ id: 'joined' })] })
    ])
    expect(h.run).toHaveBeenCalledTimes(2)
  })

  it('refreshes only the selected account, workspace and invocation', async () => {
    const h = harness()
    await h.read()
    h.installed('other-folder')
    await h.read({ workspacePath: '/other-folder' })
    h.account('/account-two')
    h.installed('other-account')
    await h.read()
    h.account('/account-one')
    h.command('second-cli')
    h.installed('other-invocation')
    await h.read()
    h.installed('refreshed')
    await h.read({ forceRefresh: true })
    h.command('first-cli')
    expect(await h.read()).toMatchObject({ models: [{ id: 'first' }] })
    expect(await h.read({ workspacePath: '/other-folder' })).toMatchObject({
      models: [{ id: 'other-folder' }]
    })
    h.account('/account-two')
    expect(await h.read()).toMatchObject({ models: [{ id: 'other-account' }] })
    expect(h.run).toHaveBeenCalledTimes(5)
  })

  it('does not force a probe for saved-only or unresolved named workspace reads', async () => {
    const h = harness()
    await h.read()
    await h.read({ forceRefresh: true, savedOnly: true })
    expect(
      await h.service.read({ agent: 'codex', workspacePath: null, forceRefresh: true })
    ).toEqual({ origin: 'unknown' })
    expect(h.run).toHaveBeenCalledTimes(1)
  })
})
