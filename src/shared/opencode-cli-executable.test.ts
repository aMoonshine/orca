import { describe, expect, it } from 'vitest'
import { assertOpenCodeCliExecutable } from './opencode-cli-executable'

describe('OpenCode CLI executable', () => {
  it('rejects the Windows desktop executable before opening a worker', () => {
    expect(() =>
      assertOpenCodeCliExecutable(
        'C:\\Users\\example\\AppData\\Local\\Programs\\@opencode-aidesktop\\OpenCode.exe'
      )
    ).toThrow('desktop app')
  })
  it.each(['C:/tools/opencode.exe', 'C:/npm/opencode.cmd', '/usr/local/bin/opencode'])(
    'accepts CLI paths: %s',
    (path) => {
      expect(() => assertOpenCodeCliExecutable(path)).not.toThrow()
    }
  )
})
