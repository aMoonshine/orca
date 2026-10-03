import { describe, expect, it } from 'vitest'
import { parseOpenCodeModels } from './opencode-model-list'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'

describe('OpenCode group model selection', () => {
  it('preserves provider-qualified IDs and ignores diagnostic lines', () => {
    expect(
      parseOpenCodeModels('Loading models...\r\nlocal/qwen\r\nopenai/gpt-5\nlocal/qwen\n')
    ).toEqual([
      { id: 'local/qwen', label: 'local/qwen' },
      { id: 'openai/gpt-5', label: 'openai/gpt-5' }
    ])
  })
  it('replaces stale CLI arguments with the chosen model', () => {
    const preferences = { model: 'provider/chosen' }
    const result = resolveAgentLaunchCommand({
      agent: 'opencode',
      cmdOverrides: {},
      platform: 'win32',
      shell: 'powershell',
      agentArgs: '--model provider/old',
      sessionOptions: preferences,
      sessionOptionsOverrideAgentArgs: true
    })
    expect(result).toMatchObject({ ok: true, appliedSessionOptions: { model: 'provider/chosen' } })
    if (result.ok) {
      expect(result.command).toContain('provider/chosen')
      expect(result.command).not.toContain('provider/old')
    }
  })
})
