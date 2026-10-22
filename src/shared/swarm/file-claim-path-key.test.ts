import { describe, expect, it } from 'vitest'
import { ClaimPathError, toClaimPathKey } from './file-claim-path-key'

describe('workspace-relative claim paths', () => {
  it.each([
    '/src/app.ts',
    'C:/repo/src/app.ts',
    'c:\\repo\\src\\app.ts',
    'C:src/app.ts',
    'C:',
    '\\\\server\\share\\src',
    '//server/share/src',
    '\\\\?\\C:\\repo',
    '\\\\.\\pipe\\orca',
    '\\src\\app.ts',
    '../app.ts',
    'src/../../app.ts'
  ])('rejects %s in both filesystem flavors', (path) => {
    for (const flavor of ['case_insensitive', 'case_sensitive'] as const) {
      expect(() => toClaimPathKey(path, flavor)).toThrow(ClaimPathError)
    }
  })

  it('preserves relative separator and dot aliases', () => {
    for (const path of ['src/app.ts', './src/app.ts', 'src/lib/../app.ts', 'src\\app.ts']) {
      expect(toClaimPathKey(path, 'case_insensitive')).toBe('src/app.ts')
    }
  })
})
