import { createAgentTeamClient } from './client'
import {
  arrangeTeamPanels,
  bootstrapMaster,
  launchMasterTerminal,
  openMasterSession,
  openTeamWorker,
  readTeamSnapshot,
  resolveTeamHandle
} from './runtime'
import { detachTeamSession, readTeamSession, saveTeamSession } from './session-state'

export const agentTeams = createAgentTeamClient(
  {
    launchMaster: launchMasterTerminal,
    resolveHandle: resolveTeamHandle,
    bootstrap: bootstrapMaster,
    readSnapshot: readTeamSnapshot,
    arrangePanels: arrangeTeamPanels,
    openMaster: openMasterSession,
    openWorker: openTeamWorker
  },
  { read: readTeamSession, save: saveTeamSession, detach: detachTeamSession }
)

export { teamSessionKey } from './contracts'
