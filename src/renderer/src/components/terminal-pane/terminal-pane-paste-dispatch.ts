import { pasteTerminalText } from './terminal-bracketed-paste'
import { executeTerminalPastePlan } from './terminal-paste-executor'
import { planTerminalPasteWithYield } from './terminal-paste-coordinator'
import type {
  TerminalPasteExecutionResult,
  TerminalPasteRuntime,
  TerminalPasteSource,
  TerminalPasteTextOptions
} from './terminal-paste-model'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'
import {
  recordTerminalConversationInput,
  withTerminalInputSource
} from './terminal-user-input-signal'

type PasteTextIntoTerminalPaneArgs = {
  pane: { id: number; leafId: string; terminal: Parameters<typeof pasteTerminalText>[0] }
  text: string
  source: TerminalPasteSource
  ptyId: string | null
  runtime: TerminalPasteRuntime
  transport: Parameters<typeof writeTerminalPastePtyInput>[0]
  inputKind: 'driving' | 'launch'
  isTargetCurrent: () => boolean
  canContinue: () => boolean
  planOptions?: Pick<
    TerminalPasteTextOptions,
    'forceBracketedPaste' | 'forceBracketedPasteForMultiline' | 'windowsInputRecordNewline'
  >
}

export async function pasteTextIntoTerminalPane({
  pane,
  text,
  source,
  ptyId,
  runtime,
  transport,
  inputKind,
  isTargetCurrent,
  canContinue,
  planOptions
}: PasteTextIntoTerminalPaneArgs): Promise<TerminalPasteExecutionResult> {
  const plan = await planTerminalPasteWithYield({
    text,
    source,
    target: { kind: 'terminal', paneId: pane.id, leafId: pane.leafId, ptyId, runtime },
    forceBracketedPaste: planOptions?.forceBracketedPaste,
    forceBracketedPasteForMultiline: planOptions?.forceBracketedPasteForMultiline,
    windowsInputRecordNewline: planOptions?.windowsInputRecordNewline,
    terminalBracketedPasteMode: pane.terminal.modes?.bracketedPasteMode === true
  })
  let recordedChunkedUserInput = false
  return executeTerminalPastePlan(plan, {
    pasteText: (pasteText, pasteOptions) =>
      withTerminalInputSource(pane.terminal, source, () =>
        pasteTerminalText(pane.terminal, pasteText, pasteOptions)
      ),
    writePty: async (data, signal) => {
      const accepted = await writeTerminalPastePtyInput(transport, data, inputKind, signal)
      if (accepted && source !== 'programmatic' && !recordedChunkedUserInput) {
        recordedChunkedUserInput = true
        recordTerminalConversationInput(pane.terminal)
      }
      return accepted
    },
    isTargetCurrent,
    canContinue
  })
}
