/**
 * Claim keys for worker file ownership.
 *
 * Why a key and not the path: two workers in one workspace must agree on whether
 * `src/App.tsx` and `src\app.tsx` are the same file, and that answer is a property
 * of the host filesystem rather than of the string either worker typed. A claim is
 * stored under a normalized, separator-agnostic, case-folded key so a later lookup
 * cannot miss an existing claim by spelling.
 */

/** Filesystem case behavior for the host a claim was made on. */
export type ClaimPathFlavor =
  /** Windows and default macOS: `A.ts` and `a.ts` are one file. */
  | 'case_insensitive'
  /** Linux and case-sensitive macOS volumes: `A.ts` and `a.ts` are two files. */
  | 'case_sensitive'

/** A claim that names a path outside the workspace, and therefore cannot be keyed. */
export class ClaimPathError extends Error {
  readonly code: 'claim_path_escapes_workspace' | 'claim_path_empty'

  constructor(code: 'claim_path_escapes_workspace' | 'claim_path_empty', message: string) {
    super(message)
    this.name = 'ClaimPathError'
    this.code = code
  }
}

/**
 * Why folding happens after normalization: `SRC/App.tsx` and `src/app.tsx` must
 * collapse to one key, but a segment may only be lowercased once the whole path is
 * in one spelling, or two segments joined by a separator could fold into a
 * different pair of segments on a case-sensitive host.
 */
function foldSegment(segment: string, flavor: ClaimPathFlavor): string {
  return flavor === 'case_insensitive' ? segment.toLowerCase() : segment
}

/**
 * Normalize a claim path into its storage key.
 *
 * Separator-agnostic and `.`/`..`-resolved so a key does not depend on how the
 * calling agent spelled the path. A `..` that escapes the workspace is refused
 * rather than clamped: a claim on `../secrets` has no meaning inside the
 * workspace, and silently clamping it to the root would hand one worker the whole
 * tree.
 */
export function toClaimPathKey(path: string, flavor: ClaimPathFlavor): string {
  // Why a backslash is a separator here: on Windows it is, and on POSIX a backslash
  // is a legal filename character - but a claim key that treated them differently
  // would let the same claim register twice on the one host that allows it.
  const unified = path.replace(/\\/g, '/')
  const segments: string[] = []
  for (const raw of unified.split('/')) {
    if (raw === '' || raw === '.') {
      continue
    }
    if (raw === '..') {
      if (segments.length === 0) {
        throw new ClaimPathError(
          'claim_path_escapes_workspace',
          `Claim path ${path} escapes the workspace root.`
        )
      }
      segments.pop()
      continue
    }
    segments.push(foldSegment(raw, flavor))
  }
  if (segments.length === 0) {
    throw new ClaimPathError('claim_path_empty', 'A claim path must name a file or directory.')
  }
  return segments.join('/')
}

/**
 * Whether two keys are in conflict: the same path, or one an ancestor of the other.
 *
 * Why ancestors count: a claim may name a directory (a worker taking `src/parser`),
 * and a directory claim overlapping any file beneath it is exactly the silent
 * overwrite this table exists to prevent. Comparing on the `key` or `key + '/'`
 * boundary keeps `src/parser` and `src/parser-ast` from reading as related when they
 * are siblings.
 */
export function claimPathsConflict(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}
