import type { Terminal } from '@xterm/xterm'
import type { TerminalPasteSource } from './terminal-paste-model'
import { isXtermMouseReport } from './terminal-pointer-input-sequences'

const terminalInputSources = new WeakMap<object, TerminalPasteSource>()
const conversationInputListeners = new WeakMap<object, Set<() => void>>()

/** Scope paste provenance to the synchronous xterm emission, never its asynchronous planning. */
export function withTerminalInputSource(
  terminal: object,
  source: TerminalPasteSource,
  write: () => void
): void {
  const previous = terminalInputSources.get(terminal)
  terminalInputSources.set(terminal, source)
  try {
    write()
  } finally {
    if (previous === undefined) {
      terminalInputSources.delete(terminal)
    } else {
      terminalInputSources.set(terminal, previous)
    }
  }
}

/** Accepted user pastes can bypass xterm when streamed directly to the PTY. */
export function recordTerminalConversationInput(terminal: object): void {
  conversationInputListeners.get(terminal)?.forEach((listener) => listener())
}

/** Ownership requires deliberate input; xterm also labels prompt delivery and mouse reports as input. */
export function subscribeToTerminalConversationInput(
  terminal: Terminal,
  listener: () => void
): { dispose: () => void } | null {
  let pendingUserInput = false
  const userInput = subscribeToTerminalUserInput(terminal, () => {
    pendingUserInput = true
  })
  if (!userInput) {
    return null
  }
  const listeners = conversationInputListeners.get(terminal) ?? new Set<() => void>()
  listeners.add(listener)
  conversationInputListeners.set(terminal, listeners)
  const dataInput = terminal.onData((data) => {
    const wasUserInput = pendingUserInput
    pendingUserInput = false
    const source = terminalInputSources.get(terminal)
    if (
      data.length > 0 &&
      source !== 'programmatic' &&
      (source !== undefined || (wasUserInput && !isXtermMouseReport(data)))
    ) {
      listener()
    }
  })
  return {
    dispose: () => {
      dataInput.dispose()
      userInput.dispose()
      listeners.delete(listener)
      if (listeners.size === 0) {
        conversationInputListeners.delete(terminal)
      }
    }
  }
}

// Why: xterm's public onData stream mixes real user input (keyboard, IME,
// paste, mouse reports) with parser-generated auto-replies (focus in/out
// reports, DA/DSR/CPR query responses). The core service already classifies
// the two, but its user signal also includes programmatic paste and pointer
// reports. Ownership uses the narrower conversation-input subscription above.
type TerminalWithCoreUserInput = {
  _core?: {
    coreService?: {
      onUserInput?: (listener: () => void) => { dispose?: unknown } | undefined
    }
  }
}

/**
 * Subscribe to xterm's core input signal, including programmatic paste and
 * pointer reports, but excluding parser replies that also flow through onData.
 *
 * Returns null when the internal API is unavailable (e.g. after an xterm
 * upgrade) so callers can fall back to onData-based recording — degrading to
 * the historical behavior instead of losing input tracking.
 */
export function subscribeToTerminalUserInput(
  terminal: Terminal,
  listener: () => void
): { dispose: () => void } | null {
  const coreService = (terminal as unknown as TerminalWithCoreUserInput)._core?.coreService
  if (!coreService || typeof coreService.onUserInput !== 'function') {
    return null
  }
  try {
    const subscription = coreService.onUserInput(listener)
    // Why: a reshaped internal that subscribes but returns no disposable must
    // not be treated as live — callers disable their onData fallback on a
    // non-null return, and activity tracking would silently disappear.
    if (subscription && typeof subscription.dispose === 'function') {
      return subscription as { dispose: () => void }
    }
    return null
  } catch {
    return null
  }
}

/** Preserve xterm's input provenance across deferred PTY forwarding. */
export function subscribeToTerminalInputData(
  terminal: Terminal,
  listener: (data: string, wasUserInput: boolean) => void
): { dispose: () => void } {
  let pendingUserInput = false
  const userInput = subscribeToTerminalUserInput(terminal, () => {
    pendingUserInput = true
  })
  const dataInput = terminal.onData((data) => {
    const wasUserInput = pendingUserInput
    pendingUserInput = false
    listener(data, wasUserInput)
  })
  return {
    dispose: () => {
      dataInput.dispose()
      userInput?.dispose()
    }
  }
}
