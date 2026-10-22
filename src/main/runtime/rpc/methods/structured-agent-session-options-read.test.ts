import '../unused-default-rpc-methods.test-fixture'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The catalog read behind the picker: which directory a named worktree runs in on this host.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getStructuredAgentSessionHost,
  setStructuredAgentSessionHost
} from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import { createAgentModelCatalogService } from '../../../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../../../native-chat/agent-model-catalog/agent-model-catalog-store'
import { createCodexModelCatalogProbe } from '../../../codex/codex-model-catalog-probe'
import type { runCodexAppServerSession } from '../../../codex/codex-app-server-session'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import { agentSessionRecordFixture } from '../../../../shared/agent-session-record.test-fixture'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime,
  type StructuredAgentSessionRuntimeDeps
} from '../../structured-agent-session-runtime'
import { ensureStructuredAgentModelCatalog } from '../../structured-agent-model-catalog-wiring'
import { journalDatabasePath } from '../../../native-chat/agent-session-journal/journal-host-database'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger'
import { defineMethod } from '../core'
import { parseRpcRequestParams } from '../dispatcher-request-parsing'
import { ModelCatalogParams } from './structured-agent-session-schemas'
import {
  call,
  clearStructuredHostStub,
  hostStub,
  SESSION,
  STRUCTURED_CLIENT as OLD_STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

const STRUCTURED_CLIENT = {
  clientKind: 'runtime' as const,
  clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
}

afterEach(() => {
  clearStructuredHostStub()
})

describe('agentSession.modelCatalog', () => {
  it('reports the exact optional refresh rejection from an older host through RPC parsing', () => {
    const oldMethod = defineMethod({
      name: 'agentSession.modelCatalog',
      permission: 'workspace',
      params: ModelCatalogParams.omit({ forceRefresh: true }),
      handler: async () => ({ origin: 'unknown' as const })
    })
    expect(
      parseRpcRequestParams(
        {
          id: 'old-host',
          authToken: 'test',
          method: 'agentSession.modelCatalog',
          params: { agent: 'codex', worktree: 'id:folder:plain', forceRefresh: true }
        },
        oldMethod,
        { runtimeId: 'old-runtime' }
      )
    ).toMatchObject({
      error: {
        ok: false,
        error: { code: 'invalid_argument', message: 'Unrecognized key: "forceRefresh"' }
      }
    })
  })
  const read = vi.fn(async () => ({ origin: 'unknown' as const }))
  let record: AgentSessionRecord | null = null

  beforeEach(() => {
    read.mockClear()
    record = null
    setStructuredAgentSessionHost(
      Object.assign(hostStub(), {
        deps: { modelCatalog: { read }, store: { getRecord: () => record }, adapter: {} }
      })
    )
  })

  it('lists the local desktop catalog under its pinned account, folder and launch arguments', async () => {
    record = {
      ...agentSessionRecordFixture(),
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/account/work' },
      launchDirectory: '/repo/work'
    }
    const listed = vi.fn()
    const runSession: typeof runCodexAppServerSession = async (invocation, body) => {
      listed(invocation)
      expect(invocation).toMatchObject({
        command: '/installed/codex',
        cwd: '/repo/work',
        env: { CODEX_HOME: '/account/work' }
      })
      expect(invocation.args).toEqual(expect.arrayContaining(['-c', 'model_provider="work"']))
      return body({
        notify: () => {},
        request: async (method) =>
          method === 'model/list'
            ? {
                data: [{ model: 'work-model', isDefault: true, supportedReasoningEfforts: [] }],
                nextCursor: null
              }
            : { config: {} }
      })
    }
    const catalog = createAgentModelCatalogService({
      store: new AgentModelCatalogStore(),
      getRecord: () => record ?? undefined,
      drivesRecord: () => true,
      recordWorkspacePath: async () => '/repo/work',
      resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: '/account/other' }),
      probes: {
        codex: createCodexModelCatalogProbe({
          resolveCommand: () => '/installed/codex',
          resolveEnvironment: async () => ({}),
          resolveLaunchArgs: () => ['-c', 'model_provider="work"'],
          runSession
        })
      }
    })
    setStructuredAgentSessionHost(
      Object.assign(hostStub(), {
        deps: { modelCatalog: catalog, store: { getRecord: () => record }, adapter: {} }
      })
    )
    try {
      const reply = await call(
        'agentSession.modelCatalog',
        { agent: 'codex', sessionId: record.sessionId, waitForListing: true },
        STRUCTURED_CLIENT
      )
      expect(reply).toMatchObject({
        ok: true,
        result: { origin: 'probe', models: [{ id: 'work-model' }] }
      })
      expect(listed).toHaveBeenCalledTimes(1)
    } finally {
      catalog.stop()
    }
  })

  it("reads a floating chat's catalog in the folder it was created in", async () => {
    const fixture = agentSessionRecordFixture()
    record = {
      ...fixture,
      location: { ...fixture.location, workspaceId: FLOATING_TERMINAL_WORKTREE_ID },
      launchDirectory: '/home/me/floating-a'
    }
    // The floating setting has since moved to another folder.
    const resolveStructuredAgentSessionLocalWorkspacePath = vi.fn(async () => '/home/me/floating-b')
    await call(
      'agentSession.modelCatalog',
      { agent: 'codex', sessionId: SESSION, worktree: `id:${FLOATING_TERMINAL_WORKTREE_ID}` },
      STRUCTURED_CLIENT,
      { resolveStructuredAgentSessionLocalWorkspacePath }
    )
    expect(resolveStructuredAgentSessionLocalWorkspacePath).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledWith({
      agent: 'codex',
      sessionId: SESSION,
      workspacePath: '/home/me/floating-a'
    })
  })

  it('reads the catalog for the directory the named worktree runs in on this host', async () => {
    const resolveStructuredAgentSessionLocalWorkspacePath = vi.fn(async () => '/repo/wt')
    await call(
      'agentSession.modelCatalog',
      { agent: 'codex', sessionId: SESSION, worktree: 'id:wt-1' },
      STRUCTURED_CLIENT,
      { resolveStructuredAgentSessionLocalWorkspacePath }
    )
    expect(resolveStructuredAgentSessionLocalWorkspacePath).toHaveBeenCalledWith('id:wt-1')
    expect(read).toHaveBeenCalledWith({
      agent: 'codex',
      sessionId: SESSION,
      workspacePath: '/repo/wt'
    })
  })

  it('does not read a native catalog when the named workspace does not resolve', async () => {
    await call(
      'agentSession.modelCatalog',
      { agent: 'codex', worktree: 'id:missing' },
      STRUCTURED_CLIENT,
      {
        resolveStructuredAgentSessionLocalWorkspacePath: vi.fn(async () => {
          throw new Error('selector_not_found')
        })
      }
    )
    expect(read).not.toHaveBeenCalled()
  })

  it.each([
    ['paired WSL', async () => null],
    [
      'HUB nested SSH',
      async (): Promise<null> => {
        throw new Error('host_not_served')
      }
    ]
  ] as const)('does not probe the native catalog for %s', async (_name, resolveWorkspace) => {
    const probe = vi.fn(async () => ({
      origin: 'probe' as const,
      complete: true,
      models: [{ id: 'native-only', label: 'Native', isDefault: true, efforts: [] }]
    }))
    const catalog = createAgentModelCatalogService({
      store: new AgentModelCatalogStore(),
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: '/native-account' }),
      probes: { codex: probe }
    })
    setStructuredAgentSessionHost(
      Object.assign(hostStub(), {
        deps: { modelCatalog: catalog, store: { getRecord: () => null }, adapter: {} }
      })
    )
    try {
      const reply = await call(
        'agentSession.modelCatalog',
        { agent: 'codex', worktree: 'id:non-native', forceRefresh: true },
        STRUCTURED_CLIENT,
        { resolveStructuredAgentSessionLocalWorkspacePath: resolveWorkspace }
      )
      expect(reply).toMatchObject({ ok: true, result: { origin: 'unknown' } })
      expect(probe).not.toHaveBeenCalled()
    } finally {
      catalog.stop()
    }
  })

  it('reads as before when no worktree is named', async () => {
    await call('agentSession.modelCatalog', { agent: 'claude' }, STRUCTURED_CLIENT)
    expect(read).toHaveBeenCalledWith({ agent: 'claude' })
  })

  it('passes a wait for the listing through to the catalog', async () => {
    await call(
      'agentSession.modelCatalog',
      { agent: 'codex', sessionId: SESSION, waitForListing: true },
      STRUCTURED_CLIENT
    )
    expect(read).toHaveBeenCalledWith({ agent: 'codex', sessionId: SESSION, waitForListing: true })
  })

  it('passes a saved-only read through to the catalog', async () => {
    await call('agentSession.modelCatalog', { agent: 'grok', savedOnly: true }, STRUCTURED_CLIENT)
    expect(read).toHaveBeenCalledWith({ agent: 'grok', savedOnly: true })
  })

  it('passes an explicit scoped refresh through to the catalog', async () => {
    await call(
      'agentSession.modelCatalog',
      { agent: 'codex', forceRefresh: true },
      STRUCTURED_CLIENT
    )
    expect(read).toHaveBeenCalledWith({ agent: 'codex', forceRefresh: true })
  })
})

describe('agentSession.modelCatalog before anything built the host', () => {
  const read = vi.fn(async () => ({
    origin: 'probe' as const,
    models: [{ id: 'gpt-host', label: 'GPT Host', isDefault: true, efforts: [] }],
    fetchedAt: 1
  }))
  const installHost = vi.fn(async () => {
    setStructuredAgentSessionHost(
      Object.assign(hostStub(), {
        deps: { modelCatalog: { read }, store: { getRecord: () => null }, adapter: {} }
      })
    )
  })

  beforeEach(() => {
    read.mockClear()
    installHost.mockClear()
    clearStructuredHostStub()
  })

  // A new chat's picker reads before its create lands; on a host with no saved chats nothing else
  // has built the host yet, and a refusal here left the picker on the client's built-in list.
  it('builds the host for a structured chat and answers from its catalog', async () => {
    const reply = await call(
      'agentSession.modelCatalog',
      { agent: 'codex', sessionId: SESSION },
      STRUCTURED_CLIENT,
      { ensureStructuredAgentSessionHost: installHost }
    )
    expect(installHost).toHaveBeenCalledTimes(1)
    expect(reply).toMatchObject({ ok: true, result: { origin: 'probe' } })
    expect(read).toHaveBeenCalledWith({ agent: 'codex', sessionId: SESSION })
  })

  it('reads an independent catalog without building the chat host', async () => {
    const getStructuredAgentModelCatalog = vi.fn(async () => ({
      read,
      peek: () => null,
      retainedLiveModelIds: async () => [],
      recordLiveListing: () => {},
      prewarm: async () => {},
      stop: () => {},
      providerStarted: () => {}
    }))
    const reply = await call('agentSession.modelCatalog', { agent: 'codex' }, STRUCTURED_CLIENT, {
      ensureStructuredAgentSessionHost: installHost,
      getStructuredAgentModelCatalog
    })
    expect(installHost).not.toHaveBeenCalled()
    expect(reply).toMatchObject({ ok: true, result: { origin: 'probe' } })
    expect(read).toHaveBeenCalledWith({ agent: 'codex' })
  })

  it('lists dynamic cold-host models under the selected account without opening a journal, then reuses the service for chats', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cold-model-catalog-'))
    let account = join(root, 'account-one')
    const runSession: typeof runCodexAppServerSession = vi.fn(async (invocation, body) => {
      expect(invocation).toMatchObject({
        command: '/installed/codex',
        cwd: expect.any(String),
        env: { CODEX_HOME: account }
      })
      expect(invocation.args).toEqual(expect.arrayContaining(['-c', 'model_provider="work"']))
      return body({
        notify: () => {},
        request: async (method) =>
          method === 'model/list'
            ? {
                data: [
                  {
                    model: account.endsWith('one') ? 'dynamic-one' : 'dynamic-two',
                    isDefault: true,
                    supportedReasoningEfforts: []
                  }
                ],
                nextCursor: null
              }
            : { config: {} }
      })
    })
    const deps: StructuredAgentSessionRuntimeDeps = {
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'cold-catalog-test',
      logger: createStructuredAgentSessionLogger(),
      resolveWorkspacePath: async () => root,
      resolveEnvironment: async () => ({}),
      resolveLaunchArgs: () => ['-c', 'model_provider="work"'],
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      resolveCodexCommand: () => '/installed/codex',
      resolveAgentAccountHome: async () => ({ variable: 'CODEX_HOME', path: account }),
      runCodexCatalogSession: runSession
    }
    const runtime = {
      ensureStructuredAgentSessionHost: installHost,
      getStructuredAgentModelCatalog: () => ensureStructuredAgentModelCatalog(deps),
      resolveStructuredAgentSessionLocalWorkspacePath: async () => root
    }
    try {
      const params = { agent: 'codex', worktree: 'id:folder:plain', waitForListing: true }
      expect(
        await call('agentSession.modelCatalog', params, STRUCTURED_CLIENT, runtime)
      ).toMatchObject({
        ok: true,
        result: { origin: 'probe', models: [{ id: 'dynamic-one' }] }
      })
      expect(getStructuredAgentSessionHost()).toBeNull()
      expect(existsSync(journalDatabasePath(root))).toBe(false)
      expect(installHost).not.toHaveBeenCalled()
      const cold = await runtime.getStructuredAgentModelCatalog()
      const host = await ensureStructuredAgentSessionHost(deps)
      expect(host.deps.modelCatalog).toBe(cold)
      expect(
        await call('agentSession.modelCatalog', params, STRUCTURED_CLIENT, runtime)
      ).toMatchObject({ ok: true, result: { models: [{ id: 'dynamic-one' }] } })
      expect(
        vi.mocked(runSession).mock.calls.filter(([invocation]) => invocation.cwd === root)
      ).toHaveLength(1)
      account = join(root, 'account-two')
      expect(
        await call('agentSession.modelCatalog', params, STRUCTURED_CLIENT, runtime)
      ).toMatchObject({ ok: true, result: { models: [{ id: 'dynamic-two' }] } })
      expect(
        vi.mocked(runSession).mock.calls.filter(([invocation]) => invocation.cwd === root)
      ).toHaveLength(2)
    } finally {
      await stopStructuredAgentSessionRuntime()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not build the host for a client that cannot read structured sessions', async () => {
    const reply = await call(
      'agentSession.modelCatalog',
      { agent: 'codex', sessionId: SESSION },
      { clientKind: 'runtime', clientCapabilities: [] },
      { ensureStructuredAgentSessionHost: installHost }
    )
    expect(installHost).not.toHaveBeenCalled()
    expect(reply).toMatchObject({ ok: false })
  })

  it('stops a cold catalog probe at runtime shutdown without creating a chat journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cold-catalog-stop-'))
    let started: (() => void) | undefined
    const listing = new Promise<void>((resolve) => {
      started = resolve
    })
    let aborted = false
    const deps: StructuredAgentSessionRuntimeDeps = {
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'cold-stop-test',
      logger: createStructuredAgentSessionLogger(),
      resolveWorkspacePath: async () => root,
      resolveEnvironment: async () => ({}),
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      resolveCodexCommand: () => '/installed/codex',
      resolveAgentAccountHome: async () => ({
        variable: 'CODEX_HOME',
        path: join(root, 'account')
      }),
      runCodexCatalogSession: async ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(new Error('probe stopped'))
            },
            { once: true }
          )
          started?.()
        })
    }
    try {
      expect(
        await ensureStructuredAgentModelCatalog({ ...deps, resolveAgentAccountHome: undefined })
      ).toBeUndefined()
      const [first, second] = await Promise.all([
        ensureStructuredAgentModelCatalog(deps),
        ensureStructuredAgentModelCatalog(deps)
      ])
      expect(first).toBe(second)
      const pending = first?.read({ agent: 'codex', workspacePath: root, waitForListing: true })
      await listing
      await stopStructuredAgentSessionRuntime()
      await pending
      expect(aborted).toBe(true)
      expect(existsSync(journalDatabasePath(root))).toBe(false)
      expect(getStructuredAgentSessionHost()).toBeNull()
      expect(await ensureStructuredAgentModelCatalog(deps)).not.toBe(first)
    } finally {
      await stopStructuredAgentSessionRuntime()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('agentSession.modelCatalog for a chat on a model its CLI stopped listing', () => {
  const opus = { id: 'opus', label: 'Opus', isDefault: true, efforts: [] }
  const read = vi.fn(async (): Promise<AgentSessionModelCatalogResult> => ({
    origin: 'probe',
    fetchedAt: 1,
    models: [opus]
  }))
  const record: AgentSessionRecord = {
    ...agentSessionRecordFixture(),
    provider: 'claude',
    options: { model: 'opus[1m]', effort: 'max' }
  }

  beforeEach(() => {
    setStructuredAgentSessionHost(
      Object.assign(hostStub(), {
        deps: { modelCatalog: { read }, store: { getRecord: () => record }, adapter: {} }
      })
    )
  })

  it("lists the chat's own model, so an older client that replaces an unlisted one keeps it", async () => {
    const own = { id: 'opus[1m]', label: 'opus[1m]', isDefault: false, efforts: [] }
    const forChat = { agent: 'claude', sessionId: record.sessionId }
    expect(await call('agentSession.modelCatalog', forChat, OLD_STRUCTURED_CLIENT)).toMatchObject({
      ok: true,
      result: { models: [opus, own] }
    })
    // A new chat's read, which seeds the next new chat's list, and the account's name only the CLI's.
    const newChat = { ...forChat, worktree: 'id:wt-1' }
    const runtime = { resolveStructuredAgentSessionLocalWorkspacePath: async () => '/repo' }
    for (const reply of [
      await call('agentSession.modelCatalog', newChat, STRUCTURED_CLIENT, runtime),
      await call('agentSession.modelCatalog', { agent: 'claude' }, STRUCTURED_CLIENT)
    ]) {
      expect(reply).toMatchObject({ ok: true, result: { models: [opus] } })
    }
  })
})
