import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { discoverModelsLocal } from './commit-message-model-discovery'
import type { SpawnSourceControlAgent } from './source-control-text-generation-types'
import { RuntimeGitGenerationCommands } from '../runtime/runtime-git-generation-commands'
import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'

const spawn = vi.hoisted(() => vi.fn<SpawnSourceControlAgent>())
vi.mock('./source-control-agent-launch', () => ({ spawnSourceControlAgent: spawn }))

beforeEach(() => {
  spawn.mockReset()
  spawn.mockImplementation((input) => {
    const child = Object.assign(new ChildProcess(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      pid: 1234
    })
    queueMicrotask(() => {
      const id = input.cwd?.includes('plain-folder')
        ? 'project/folder-model'
        : 'project/worktree-model'
      child.stdout.write(`${id}\n`)
      child.emit('close', 0)
    })
    return child
  })
})

function target(wslDistro?: string): RuntimeGitTarget {
  const git = {
    path: '/project/plain-folder',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    head: 'a'.repeat(40)
  }
  return {
    executionHostId: 'local',
    ...(wslDistro ? { localGitOptions: { wslDistro } } : {}),
    worktree: {
      ...git,
      git,
      id: 'folder:plain',
      repoId: '',
      displayName: 'Plain folder',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    }
  }
}

describe('workspace model discovery', () => {
  it.each([undefined, 'Ubuntu'])(
    'keeps the folder cwd and configured launch env on runtime %s',
    async (wslDistro) => {
      const commands = new RuntimeGitGenerationCommands({
        resolveRuntimeGitTarget: async () => target(wslDistro),
        getRuntimeSettings: () => ({
          agentCmdOverrides: { opencode: '/configured/opencode' },
          agentDefaultEnv: { opencode: { OPENCODE_CONFIG_CONTENT: '{"provider":{"project":{}}}' } }
        }),
        getCommitMessageAgentEnvironment: () => ({
          resolveBaseEnvironment: async () => ({ HOME: '/account', PATH: '/bin' })
        })
      })
      const result = await commands.discoverRuntimeCommitMessageModels(
        'id:folder:plain',
        'opencode'
      )
      expect(result).toMatchObject({
        success: true,
        catalogOrigin: 'probe',
        models: expect.arrayContaining([expect.objectContaining({ id: 'project/folder-model' })])
      })
      expect(spawn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          binary: '/configured/opencode',
          args: ['models'],
          cwd: '/project/plain-folder',
          wslDistro,
          useCwdForNative: true,
          commandEnv: { OPENCODE_CONFIG_CONTENT: '{"provider":{"project":{}}}' }
        })
      )
      if (!wslDistro) {
        expect(spawn.mock.calls[0]?.[0].env).toMatchObject({
          HOME: '/account',
          OPENCODE_CONFIG_CONTENT: '{"provider":{"project":{}}}'
        })
      }
    }
  )

  it.each([undefined, 'Ubuntu'])(
    'keeps inline command env precedence over launch settings on runtime %s',
    async (wslDistro) => {
      const result = await discoverModelsLocal({
        agentId: 'opencode',
        env: { BASE: 'host-base' },
        agentCommandOverride: 'MODEL_PROVIDER=inline /configured/opencode',
        options: {
          cwd: '/project/git-worktree',
          wslDistro,
          launchEnv: { MODEL_PROVIDER: 'settings', PROJECT_CONFIG: 'configured' }
        },
        backslash: 'escape',
        spawnAgent: spawn
      })
      expect(result).toMatchObject({ success: true, catalogOrigin: 'probe' })
      expect(spawn.mock.calls[0]?.[0]).toMatchObject({
        cwd: '/project/git-worktree',
        wslDistro,
        useCwdForNative: true,
        commandEnv: { MODEL_PROVIDER: 'inline', PROJECT_CONFIG: 'configured' },
        env: wslDistro
          ? { BASE: 'host-base' }
          : expect.objectContaining({ MODEL_PROVIDER: 'inline', PROJECT_CONFIG: 'configured' })
      })
    }
  )

  it('refuses an unserved nested SSH workspace before a native probe', async () => {
    const commands = new RuntimeGitGenerationCommands({
      resolveRuntimeGitTarget: async () => ({ ...target(), executionHostId: 'ssh:nested' }),
      getRuntimeSettings: () => ({})
    })
    expect(
      await commands.discoverRuntimeCommitMessageModels('id:folder:plain', 'opencode')
    ).toMatchObject({ success: false })
    expect(spawn).not.toHaveBeenCalled()
  })
})
