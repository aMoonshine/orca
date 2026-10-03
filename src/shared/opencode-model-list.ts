export function parseOpenCodeModels(stdout: string): { id: string; label: string }[] {
  return [...new Set(stdout.split(/\r?\n/).map((line) => line.trim()))]
    .filter((line) => /^[\w.-]+\/[^\s]+$/.test(line))
    .map((id) => ({ id, label: id }))
}
