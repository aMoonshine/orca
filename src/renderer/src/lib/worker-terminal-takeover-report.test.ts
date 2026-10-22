// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { pasteTextIntoTerminalPane } from '@/components/terminal-pane/terminal-pane-paste-dispatch'
import type { TerminalPasteSource } from '@/components/terminal-pane/terminal-paste-model'
import { TERMINAL_PASTE_DIRECT_MAX_BYTES } from '@/components/terminal-pane/terminal-paste-limits'
import { subscribeToTerminalConversationInput } from '@/components/terminal-pane/terminal-user-input-signal'
import { reportWorkerTerminalUserInput } from './worker-terminal-takeover-report'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

describe('reportWorkerTerminalUserInput', () => {
  beforeEach(() => {
    vi.mocked(callRuntimeRpc).mockReset().mockResolvedValue({ changed: 1 })
  })

  it('throttles per runtime target so a rebound pane reports to its new owner', () => {
    reportWorkerTerminalUserInput('pane-runtime-rebind', null)
    reportWorkerTerminalUserInput('pane-runtime-rebind', null)
    reportWorkerTerminalUserInput('pane-runtime-rebind', 'runtime-remote')
    reportWorkerTerminalUserInput('pane-runtime-rebind', 'runtime-remote')

    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      1,
      { kind: 'local' },
      'orchestration.workerTerminalUserInput',
      { paneKey: 'pane-runtime-rebind' },
      { suppressFeatureInteraction: true, reuseRecentCompatibilityFailure: true }
    )
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      2,
      { kind: 'environment', environmentId: 'runtime-remote' },
      'orchestration.workerTerminalUserInput',
      { paneKey: 'pane-runtime-rebind' },
      { suppressFeatureInteraction: true, reuseRecentCompatibilityFailure: true }
    )
  })

  it('retries one transient report failure without waiting for more user input', async () => {
    vi.mocked(callRuntimeRpc).mockRejectedValueOnce(new Error('runtime reconnecting'))

    reportWorkerTerminalUserInput('pane-transient-failure', 'runtime-reconnecting')
    await vi.waitFor(() => expect(callRuntimeRpc).toHaveBeenCalledTimes(2), { timeout: 1_000 })

    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
  })
})

describe('xterm takeover boundary', () => {
  let terminal: Terminal
  let originalGetContext: PropertyDescriptor | undefined

  function paste(
    source: TerminalPasteSource,
    text: string,
    options: Partial<Parameters<typeof pasteTextIntoTerminalPane>[0]> = {}
  ) {
    return pasteTextIntoTerminalPane({
      pane: { id: 1, leafId: 'worker', terminal },
      text,
      source,
      ptyId: 'pty-worker',
      runtime: { platform: 'win32', runtimeKey: 'local', kind: 'local' },
      transport: undefined,
      inputKind: 'driving',
      isTargetCurrent: () => true,
      canContinue: () => true,
      ...options
    })
  }

  beforeEach(() => {
    vi.mocked(callRuntimeRpc).mockReset().mockResolvedValue({ changed: 1 })
    originalGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({ measureText: () => ({ width: 10 }) })
    })
    terminal = new Terminal({ cols: 40, rows: 8 })
    const container = document.createElement('div')
    document.body.appendChild(container)
    terminal.open(container)
  })

  afterEach(() => {
    terminal.dispose()
    if (originalGetContext) {
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', originalGetContext)
    } else {
      Reflect.deleteProperty(HTMLCanvasElement.prototype, 'getContext')
    }
    document.body.replaceChildren()
  })

  it('delivers a programmatic dispatch without reporting user takeover', async () => {
    subscribeToTerminalConversationInput(terminal, () =>
      reportWorkerTerminalUserInput('pane-programmatic-dispatch', null)
    )
    const data = vi.fn()
    terminal.onData(data)

    const result = await pasteTextIntoTerminalPane({
      pane: { id: 1, leafId: 'worker', terminal },
      text: 'Dispatch preamble\nTask body',
      source: 'programmatic',
      ptyId: 'pty-worker',
      runtime: { platform: 'win32', runtimeKey: 'local', kind: 'local' },
      transport: undefined,
      inputKind: 'driving',
      isTargetCurrent: () => true,
      canContinue: () => true
    })

    expect(result.status).toBe('pasted')
    expect(data).toHaveBeenCalledWith('Dispatch preamble\rTask body')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('does not report mouse tracking as takeover', () => {
    subscribeToTerminalConversationInput(terminal, () =>
      reportWorkerTerminalUserInput('pane-mouse-tracking', 'remote-owner')
    )
    terminal.input('\x1b[<35;2;3M', true)
    terminal.input('\x1b[<0;2;3M', true)
    terminal.input('\x1b[<0;2;3m', true)
    terminal.input('\x1b[<64;2;3M', true)
    terminal.input('\x1b[M !!', true)
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('ignores parser replies, focus reports, output and resize before immediate typing', async () => {
    subscribeToTerminalConversationInput(terminal, () =>
      reportWorkerTerminalUserInput('pane-parser-and-resize', null)
    )
    const data = vi.fn()
    terminal.onData(data)
    terminal.resize(60, 12)
    terminal.input('\x1b[I', false)
    terminal.input('\x1b[O', false)
    await new Promise<void>((resolve) => terminal.write('provider output\x1b[6n', resolve))
    expect(data).toHaveBeenCalledWith('\x1b[1;16R')
    expect(callRuntimeRpc).not.toHaveBeenCalled()

    terminal.input('user text', true)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it.each(['\x03', '\x1b', '\x1b[A', 'IME text'])(
    'keeps conservative takeover for deliberate input %j',
    (input) => {
      subscribeToTerminalConversationInput(terminal, () =>
        reportWorkerTerminalUserInput(`pane-deliberate-${JSON.stringify(input)}`, 'remote-owner')
      )
      terminal.input(input, true)
      expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    'keyboard',
    'paste-event',
    'app-menu',
    'context-menu',
    'right-click',
    'middle-click'
  ] as const)('keeps %s paste takeover after programmatic delivery', async (source) => {
    subscribeToTerminalConversationInput(terminal, () =>
      reportWorkerTerminalUserInput(`pane-user-paste-${source}`, null)
    )
    await paste('programmatic', 'orchestration prompt')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    await paste(source, 'my conversation')
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it.each([
    { forceBracketedPaste: true },
    { windowsInputRecordNewline: 'alt-enter' },
    { windowsInputRecordNewline: 'csi-u' }
  ] as const)('preserves provenance for encoded paste %j', async (planOptions) => {
    subscribeToTerminalConversationInput(terminal, () =>
      reportWorkerTerminalUserInput(`pane-encoded-${JSON.stringify(planOptions)}`, null)
    )
    const data = vi.fn()
    terminal.onData(data)
    await paste('programmatic', 'one\ntwo', { planOptions })
    expect(data).toHaveBeenCalledTimes(1)
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    await paste('paste-event', 'one\ntwo', { planOptions })
    expect(data).toHaveBeenCalledTimes(2)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('reports user typing while a programmatic chunk write awaits acknowledgement', async () => {
    subscribeToTerminalConversationInput(terminal, () =>
      reportWorkerTerminalUserInput('pane-interleaved-chunks', 'remote-owner')
    )
    let acceptFirst!: (accepted: boolean) => void
    const firstAccepted = new Promise<boolean>((resolve) => {
      acceptFirst = resolve
    })
    let noteFirstWrite!: () => void
    const firstWritten = new Promise<void>((resolve) => {
      noteFirstWrite = resolve
    })
    const writes: string[] = []
    const sendInputAccepted = vi.fn((data: string) => {
      writes.push(data)
      if (writes.length === 1) {
        noteFirstWrite()
        return firstAccepted
      }
      return Promise.resolve(true)
    })
    const text = 'x'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES + 1)
    const delivery = paste('programmatic', text, {
      transport: { sendInput: () => true, sendInputAccepted }
    })
    await firstWritten
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    terminal.input('user intervenes', true)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
    acceptFirst(true)
    expect((await delivery).status).toBe('pasted')
    expect(writes.join('')).toBe(text)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('reports a partially accepted user paste even if the next chunk is rejected', async () => {
    subscribeToTerminalConversationInput(terminal, () =>
      reportWorkerTerminalUserInput('pane-partial-user-paste', null)
    )
    let writes = 0
    const result = await paste('paste-event', 'x'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES + 1), {
      transport: { sendInput: () => ++writes === 1 }
    })
    expect(result).toMatchObject({ status: 'cancelled', chunksWritten: 1 })
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('does not report a user paste whose first chunk is rejected', async () => {
    subscribeToTerminalConversationInput(terminal, () =>
      reportWorkerTerminalUserInput('pane-rejected-user-paste', null)
    )
    const result = await paste('paste-event', 'x'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES + 1), {
      transport: { sendInput: () => false }
    })
    expect(result).toMatchObject({ status: 'cancelled', chunksWritten: 0 })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })
})
