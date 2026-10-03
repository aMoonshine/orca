/** Windows resolves the desktop app by the same command name as the terminal CLI. */
export function assertOpenCodeCliExecutable(executable: string): void {
  if (/(?:^|[/\\])@opencode-aidesktop[/\\]opencode\.exe$/i.test(executable)) {
    throw new Error(
      'OpenCode resolves to the desktop app, not its terminal CLI. Install the OpenCode CLI and set its command in Settings > Agents, then launch again.'
    )
  }
}
