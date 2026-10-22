# Running Orca from source on Windows

In this checkout, use `tools\orca-dev.cmd`. The launcher runs Electron from source
with a project-local Node 24.21.0; no installer or packaged executable is built.

From the repository root in PowerShell:

```powershell
.\tools\orca-dev.cmd install-node
.\tools\orca-dev.cmd install
.\tools\orca-dev.cmd doctor
.\tools\orca-dev.cmd dev
```

Install JavaScript dependencies and compiler prerequisites according to the root
README first. `install` rebuilds native modules for Electron. After setup, use only
`dev` for normal launches and keep its console open while using the application.
`doctor` checks prerequisites without opening the app. `native` rebuilds modules
for local Node tools instead of Electron.

Before launching the app, `dev` builds the CLI and runs the standard
`verify-cli-bin.mjs --fix-executable --fix-package-json` preparation. This writes
the compiled output's CommonJS package boundary, version and source commit used
by the CLI. A failed build or preparation stops the launch.

For the existing `orca_swarm` wrapper installation, Node already lives in the outer
`tools/runtime` directory. Use the outer `tools\orca-dev.cmd`, or double-click
`Start Orca.cmd` in the wrapper root. This launcher has the correct paths for that
layout.

## Local artifacts

Keep development logs, temporary downloads and isolated validation profiles under
an ignored `artifacts/` directory. Group them by purpose and validation date:

```text
artifacts/
  logs/YYYY-MM-DD/
  validation/YYYY-MM-DD/
  downloads/
  cache/
```

For the wrapper installation, this directory belongs beside `orca/`. Archive
inactive profiles with their validation results. Keep portable Node under
`tools/runtime` and leave the dependency/build directories in their expected
locations. Do not commit local profiles, runtime binaries or diagnostic logs.

See [fork maintenance](../extensions/README.md) and
[agent groups](../docs/reference/agent-groups.md) for the available features.

## Local OpenCode CLI

Run `tools\orca-dev.cmd install-opencode`, then restart Orca with the launcher.
This installs the exact `$OpenCodeVersion` from `orca-dev.ps1` (currently
`1.18.32`) into `tools/runtime/opencode-cli`. Repeating it restores that pin;
it does not check or install the latest published release. To change the pin,
choose a supported release and update `$OpenCodeVersion` in the launcher you
actually use. The wrapper launcher and this checkout's launcher are separate
files with separate runtime directories.

The launcher prepends portable Node and, when present, the portable OpenCode
binary directory to its process's PATH. Its children inherit that order, so a
different CLI installed elsewhere may remain unused after an update. `doctor`
prints the configured OpenCode pin and install root, then the selected OpenCode
and Codex executable paths and their reported versions. It warns about the
OpenCode desktop app without launching it. A supported version is a compatibility
verdict, not evidence that it is the latest release.

Check update targets in an Orca terminal before installing anything:

```powershell
Get-Command opencode,codex,npm -All | Select-Object Name,Source
npm prefix -g
codex --version
```

Run `opencode --version` only after confirming that it resolves to the terminal
CLI. A CLI prompt running `npm install -g @openai/codex` uses the selected npm
and its configured global prefix. With portable Node first on PATH, that prefix
can be the portable Node directory rather than the user's npm directory.
Updating a separate npm installation does not replace the selected portable CLI.
The OpenCode pin uses `npm install --prefix` and its own directory instead.

These checks describe the local host. An SSH or connected Orca server owns its
own CLI installation, PATH, npm prefix and version probes; updating the Windows
client's portable CLI does not update that server. Verify the selected executable
and version on the execution host before attributing remote behavior to a local
update. Other providers still need their own CLI and login.
