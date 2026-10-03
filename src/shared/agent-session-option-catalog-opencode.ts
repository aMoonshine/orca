import { hasFlag } from './agent-cli-flag-detection'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'
import { parseOpenCodeModels } from './opencode-model-list'

export const OPENCODE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  models: [],
  supportsWorkerLaunchPreferences: true,
  discoveredModelsAreAuthoritative: true,
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['-m', '--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['-m', '--model'])
  },
  listModels: {
    command: 'opencode models',
    parse: (stdout) => parseOpenCodeModels(stdout).map((model) => ({ ...model, options: [] }))
  }
}
