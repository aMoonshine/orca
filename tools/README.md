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
The pinned terminal CLI is installed in `tools/runtime/opencode-cli`; its path is
used only by Orca and its children. `doctor` identifies accidental resolution to
the OpenCode desktop app. Other providers still need their own CLI and login.
