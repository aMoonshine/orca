import { beforeEach, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { getDefaultSettings } from '../../../shared/constants'
import type * as LocalPreflightContext from './local-preflight-context'
import { ModelCatalogParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import { compile } from 'zod'

const mocks = vi.hoisted(() => {
  const settings: Partial<GlobalSettings> = {}
  return {
    rpc: vi.fn(),
    connection: vi.fn<() => string | null | undefined>(() => null),
    runtime: vi.fn(),
    settings,
    folder: {
      id: 'plain',
      projectGroupId: 'group',
      folderPath: '/project',
      name: 'Plain',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    } satisfies FolderWorkspace,
    discover: vi.fn()
  }
})

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: mocks.settings, folderWorkspaces: [mocks.folder] }) }
}))
vi.mock('./connection-context', () => ({ getConnectionIdFromState: mocks.connection }))
vi.mock('./local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: mocks.runtime
}))
vi.mock('./folder-workspace-runtime-owner', () => ({
  findFolderWorkspaceOwner: () => mocks.folder
}))

import { loadAgentGroupModels } from './agent-group-model-discovery'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'

const local = { kind: 'local' } as const
const currentModels = [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }]
const seedModels = [{ id: 'gpt-5.5', label: 'GPT-5.5' }]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connection.mockReturnValue(null)
  mocks.runtime.mockReturnValue(undefined)
  mocks.settings = {}
  mocks.folder.folderPath = '/project'
  vi.stubGlobal('window', { api: { git: { discoverCommitMessageModels: mocks.discover } } })
  mocks.discover.mockResolvedValue({ success: true, models: seedModels })
  mocks.rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.modelCatalog'
      ? { origin: 'probe', models: currentModels, fetchedAt: 1 }
      : { success: true, models: seedModels }
  )
})

it.each([local, { kind: 'environment', environmentId: 'server' } as const])(
  'lists current Codex models from the selected runtime %j',
  async (target) => {
    expect(await loadAgentGroupModels(target, 'repo::/project', 'codex')).toEqual(currentModels)
    expect(mocks.rpc).toHaveBeenCalledWith(
      target,
      'agentSession.modelCatalog',
      { agent: 'codex', worktree: 'id:repo::/project' },
      expect.anything()
    )
  }
)

it('waits for the first host listing and refreshes after a completed request', async () => {
  mocks.rpc.mockResolvedValueOnce({ origin: 'unknown', listingInProgress: true })
  expect(await loadAgentGroupModels(local, 'repo::/project', 'codex')).toEqual(currentModels)
  expect(mocks.rpc).toHaveBeenNthCalledWith(
    2,
    local,
    'agentSession.modelCatalog',
    { agent: 'codex', worktree: 'id:repo::/project', waitForListing: true },
    expect.anything()
  )
  const nextModels = [...currentModels, { id: 'new-model', label: 'New model' }]
  mocks.rpc.mockResolvedValueOnce({ origin: 'probe', models: nextModels, fetchedAt: 2 })
  expect(await loadAgentGroupModels(local, 'repo::/project', 'codex')).toEqual(nextModels)
})

it('keeps legacy discovery on a host that lacks the catalog method', async () => {
  mocks.rpc.mockRejectedValueOnce(
    new RuntimeRpcCallError({
      id: 'legacy',
      ok: false,
      error: { code: 'method_not_found', message: 'Unsupported' }
    })
  )
  expect(await loadAgentGroupModels(local, 'repo::/project', 'codex')).toEqual(seedModels)
})

it('retains host effort metadata without changing exact model IDs', async () => {
  const models = [
    {
      id: 'gpt-6.1-sol',
      label: 'Host Sol',
      defaultEffort: 'high',
      efforts: [{ value: 'high', label: 'Host high' }]
    },
    { id: 'opaque/model', label: 'Unknown efforts', effortsKnown: false, efforts: [] }
  ]
  mocks.rpc.mockResolvedValueOnce({ origin: 'probe', models })
  expect(await loadAgentGroupModels(local, 'folder:plain', 'codex')).toEqual(models)
})

it.each([local, { kind: 'environment', environmentId: 'server' } as const])(
  'surfaces a disconnected host instead of displaying the static seed: %j',
  async (target) => {
    mocks.rpc.mockRejectedValueOnce(new Error('Host disconnected'))
    await expect(loadAgentGroupModels(target, 'repo::/project', 'codex')).rejects.toThrow(
      'Host disconnected'
    )
  }
)

it.each(['ssh-target', undefined])(
  'does not read native models for an SSH or unresolved owner %s',
  async (connection) => {
    mocks.connection.mockReturnValue(connection)
    expect(await loadAgentGroupModels(local, 'repo::/project', 'codex')).toEqual(seedModels)
    expect(mocks.rpc.mock.calls.every(([, method]) => method !== 'agentSession.modelCatalog')).toBe(
      true
    )
  }
)

it('keeps WSL discovery on its execution host', async () => {
  mocks.runtime.mockReturnValue({ status: 'resolved', runtime: { kind: 'wsl', distro: 'Ubuntu' } })
  expect(await loadAgentGroupModels(local, 'repo::/project', 'codex')).toEqual(seedModels)
})

it.each(['opencode', 'opencode2'])('uses the registered catalog for native %s', async (agent) => {
  expect(await loadAgentGroupModels(local, 'repo::/project', agent)).toEqual(currentModels)
  expect(mocks.rpc.mock.calls.map(([, method]) => method)).toEqual(['agentSession.modelCatalog'])
})

it('forces a provider refresh and joins duplicate explicit refresh requests', async () => {
  await loadAgentGroupModels(local, 'repo::/project', 'codex')
  const first = loadAgentGroupModels(local, 'repo::/project', 'codex', { forceRefresh: true })
  const second = loadAgentGroupModels(local, 'repo::/project', 'codex', { forceRefresh: true })
  expect(first).toBe(second)
  await first
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    local,
    'agentSession.modelCatalog',
    {
      agent: 'codex',
      worktree: 'id:repo::/project',
      forceRefresh: true
    },
    expect.anything()
  )
  expect(mocks.rpc).toHaveBeenCalledTimes(2)
})

it('retries an old host only when it explicitly rejects the optional refresh field', async () => {
  const oldParams = compile(ModelCatalogParams.omit({ forceRefresh: true }))
  mocks.rpc.mockImplementationOnce(async (_target, _method, params) => {
    const parsed = oldParams.safeParse(params)
    if (parsed.success) {
      throw new Error('Expected old-host validation to reject refresh')
    }
    throw new RuntimeRpcCallError({
      id: 'old-host',
      ok: false,
      error: {
        code: 'invalid_argument',
        message: parsed.error.issues[0]?.message ?? 'invalid_argument'
      }
    })
  })
  expect(
    await loadAgentGroupModels(local, 'repo::/project', 'codex', { forceRefresh: true })
  ).toEqual(currentModels)
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    local,
    'agentSession.modelCatalog',
    {
      agent: 'codex',
      worktree: 'id:repo::/project'
    },
    expect.anything()
  )
})

it('does not retry a rejected workspace or disconnected host without refresh', async () => {
  mocks.rpc.mockRejectedValueOnce(
    new RuntimeRpcCallError({
      id: 'invalid-workspace',
      ok: false,
      error: { code: 'invalid_argument', message: 'Workspace unavailable' }
    })
  )
  await expect(
    loadAgentGroupModels(local, 'repo::/project', 'codex', { forceRefresh: true })
  ).rejects.toThrow('Workspace unavailable')
  expect(mocks.rpc).toHaveBeenCalledTimes(1)
})

it.each(['codex', 'opencode'])(
  'routes a paired non-native %s workspace through host discovery',
  async (agent) => {
    const target = { kind: 'environment', environmentId: 'paired-host' } as const
    mocks.rpc.mockResolvedValueOnce({ origin: 'unknown' })
    expect(await loadAgentGroupModels(target, 'folder:plain', agent)).toEqual(seedModels)
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      target,
      'git.discoverCommitMessageModels',
      {
        worktree: 'id:folder:plain',
        agentId: agent
      },
      expect.anything()
    )
    expect(mocks.discover).not.toHaveBeenCalled()
  }
)

it.each([null, undefined, 'desktop-ssh'])(
  'uses the paired host despite desktop owner %s and command override',
  async (connection) => {
    mocks.connection.mockReturnValue(connection)
    mocks.settings = { agentCmdOverrides: { codex: 'desktop-codex' } }
    const target = { kind: 'environment', environmentId: 'server' } as const
    expect(await loadAgentGroupModels(target, 'repo::/project', 'codex')).toEqual(currentModels)
    expect(mocks.rpc.mock.calls.map(([, method]) => method)).toEqual(['agentSession.modelCatalog'])
  }
)

it('keeps desktop custom commands on CLI discovery', async () => {
  mocks.settings = { agentCmdOverrides: { codex: 'desktop-codex' } }
  expect(await loadAgentGroupModels(local, 'repo::/project', 'codex')).toEqual(seedModels)
  expect(mocks.rpc.mock.calls.map(([, method]) => method)).toEqual([
    'git.discoverCommitMessageModels'
  ])
})

it.each([
  String.raw`C:\project`,
  String.raw`\\wsl.localhost\Ubuntu\home\me\project`,
  String.raw`\\wsl$\Debian\home\me\project`
])('resolves a repository-free folder on its actual execution host: %s', async (folderPath) => {
  const { getLocalProjectExecutionRuntimeContext } = await vi.importActual<
    typeof LocalPreflightContext
  >('./local-preflight-context')
  mocks.folder.folderPath = folderPath
  const state = {
    activeRepoId: null,
    activeWorktreeId: 'folder:plain',
    repos: [],
    projects: [],
    worktreesByRepo: {},
    folderWorkspaces: [mocks.folder],
    projectGroups: [],
    settings: {
      ...getDefaultSettings('/home/test'),
      localWindowsRuntimeDefault: { kind: 'windows-host' as const }
    }
  }
  mocks.runtime.mockImplementation(() =>
    getLocalProjectExecutionRuntimeContext(state, 'folder:plain', 'win32')
  )
  const windows = folderPath.startsWith('C:')
  expect(await loadAgentGroupModels(local, 'folder:plain', 'codex')).toEqual(
    windows ? currentModels : seedModels
  )
  expect(mocks.rpc.mock.calls.map(([, method]) => method)).toEqual(
    windows ? ['agentSession.modelCatalog'] : []
  )
  expect(mocks.discover).toHaveBeenCalledTimes(windows ? 0 : 1)
  if (!windows) {
    expect(mocks.discover).toHaveBeenCalledWith({
      agentId: 'codex',
      worktreePath: folderPath,
      connectionId: undefined
    })
  }
})

it('does not join an in-flight read from the previous selected account', async () => {
  let finish: ((value: unknown) => void) | undefined
  mocks.rpc.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const previous = loadAgentGroupModels(local, 'repo::/project', 'codex')
  mocks.settings = { activeCodexManagedAccountId: 'other-account' }
  expect(await loadAgentGroupModels(local, 'repo::/project', 'codex')).toEqual(currentModels)
  finish?.({ origin: 'probe', models: seedModels })
  expect(await previous).toEqual(seedModels)
  expect(mocks.rpc).toHaveBeenCalledTimes(2)
})
