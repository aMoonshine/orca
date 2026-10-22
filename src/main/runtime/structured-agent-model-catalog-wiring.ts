import { agentSessionPinnedLaunchDirectory } from './agent-session-record-launch-directory'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { createAgentModelCatalogFilePersistence } from '../native-chat/agent-model-catalog/agent-model-catalog-persistence'
import {
  createAgentModelCatalogService,
  type AgentModelCatalogService,
  type AgentModelCatalogServiceDeps
} from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import {
  agentReadsProjectModelConfig,
  workspaceMayOverrideDefaultModel
} from '../native-chat/agent-model-catalog/agent-project-model-override'
import type { AgentModelCatalogProbe } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import type {
  StructuredAgentModelCatalogContext,
  StructuredAgentRuntimeRegistration
} from './structured-agent-runtime-registrations'
import type { StructuredAgentRegistry } from '../native-chat/agent-session-wire/structured-agent-registry'
import { agentDrivesSession } from '../native-chat/agent-session-wire/structured-agent-session-provider-support'
import { STRUCTURED_AGENT_RUNTIME_CATALOG } from './structured-agent-runtime-metadata'
import { createStructuredAgentEnvironmentResolvers } from './structured-agent-shell-environment'

// The store is process-global; hydrate it from disk at most once per process.
let persistenceAttached: Promise<void> | null = null
let catalogService: Promise<{ modelCatalog?: AgentModelCatalogService }> | null = null
let sessionContext: {
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'listRecords'>
  agents: Pick<StructuredAgentRegistry, 'definition'>
} | null = null

export async function attachAgentModelCatalogPersistenceOnce(
  stateDirectory: string
): Promise<void> {
  persistenceAttached ??= agentModelCatalogStore
    .attachPersistence(createAgentModelCatalogFilePersistence(stateDirectory))
    .catch(() => {})
  await persistenceAttached
}

type CatalogRegistration = Pick<StructuredAgentRuntimeRegistration, 'definition' | 'modelCatalog'>

/** Catalog reads use chat launch resolvers without opening the record store or journal. */
export async function ensureStructuredAgentModelCatalog(
  deps: StructuredAgentModelCatalogContext['deps']
): Promise<AgentModelCatalogService | undefined> {
  return (
    await modelCatalogHostDeps({
      deps,
      environment: createStructuredAgentEnvironmentResolvers(deps),
      registrations: STRUCTURED_AGENT_RUNTIME_CATALOG.map(({ metadata }) => metadata)
    })
  ).modelCatalog
}

/** What the catalog service learns from the registration list, the only agent roster. */
export function registeredModelCatalogDiscovery(
  registrations: readonly CatalogRegistration[],
  context: StructuredAgentModelCatalogContext
): {
  probes: Record<string, AgentModelCatalogProbe>
  listingNamesConfiguredModel: Set<string>
  listsInChatFolder: Set<string>
} {
  const probes: Record<string, AgentModelCatalogProbe> = {}
  const listingNamesConfiguredModel = new Set<string>()
  const listsInChatFolder = new Set<string>()
  for (const registration of registrations) {
    const { agent } = registration.definition
    const discovery = registration.modelCatalog(context)
    if (discovery.kind === 'probe') {
      probes[agent] = discovery.probe
      if (discovery.listingNamesConfiguredModel) {
        listingNamesConfiguredModel.add(agent)
      }
      if (discovery.listsInChatFolder) {
        listsInChatFolder.add(agent)
      }
    }
  }
  return { probes, listingNamesConfiguredModel, listsInChatFolder }
}

/**
 * The host-deps slice for the catalog surface: hydrates the store from disk
 * once, then builds the service — or nothing, when the runtime cannot name
 * the currently selected account, in which case every catalog read answers
 * `unknown` rather than guessing a key.
 */
export async function modelCatalogHostDeps(input: {
  store?: Pick<AgentSessionRecordStore, 'getRecord' | 'listRecords'>
  agents?: Pick<StructuredAgentRegistry, 'definition'>
  registrations: readonly CatalogRegistration[]
  deps: StructuredAgentModelCatalogContext['deps']
  environment: StructuredAgentModelCatalogContext['environment']
}): Promise<{ modelCatalog?: AgentModelCatalogService }> {
  if (input.store && input.agents) {
    sessionContext = { store: input.store, agents: input.agents }
  }
  if (!catalogService && !input.deps.resolveAgentAccountHome) {
    return {}
  }
  catalogService ??= createHostCatalog(input).catch((error) => {
    catalogService = null
    throw error
  })
  return catalogService
}

async function createHostCatalog(
  input: Parameters<typeof modelCatalogHostDeps>[0]
): Promise<{ modelCatalog?: AgentModelCatalogService }> {
  await attachAgentModelCatalogPersistenceOnce(input.deps.stateDirectory)
  const { deps } = input
  if (!deps.resolveAgentAccountHome) {
    return {}
  }
  const modelCatalog = createAgentModelCatalogService({
    store: agentModelCatalogStore,
    getRecord: (sessionId) => sessionContext?.store.getRecord(sessionId) ?? undefined,
    drivesRecord: (record) =>
      sessionContext !== null && agentDrivesSession(sessionContext.agents, record),
    resolveAccountHome: deps.resolveAgentAccountHome,
    recordWorkspacePath: async (record) =>
      agentSessionPinnedLaunchDirectory(record) ??
      (await deps.resolveWorkspacePath(record.location.workspaceId).catch(() => null)),
    agentReadsProjectModelConfig,
    workspaceMayOverrideDefaultModel,
    hasChatRecords: (agent) =>
      sessionContext?.store.listRecords().some((record) => record.provider === agent) ?? false,
    ...registeredModelCatalogDiscovery(input.registrations, {
      deps,
      environment: input.environment
    })
  })
  return { modelCatalog }
}

/** A catalog created by a picker or chat rechecks what the changed host settings made cold. */
export function prewarmStructuredAgentModelCatalogs(): void {
  void catalogService?.then(({ modelCatalog }) => modelCatalog?.prewarm()).catch(() => {})
}

export async function stopStructuredAgentModelCatalog(): Promise<void> {
  const pending = catalogService
  catalogService = null
  sessionContext = null
  const catalog = await pending?.catch(() => null)
  catalog?.modelCatalog?.stop()
  await agentModelCatalogStore.flushPersistence()
}

// Re-exported so the runtime deps type can reference the resolver shape without
// importing the service module directly.
export type RuntimeAgentAccountHomeResolver = AgentModelCatalogServiceDeps['resolveAccountHome']
