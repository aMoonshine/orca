<#
.SYNOPSIS
  Runs the Orca fork from source on Windows, without packaging an .exe.

.DESCRIPTION
  Orca is an Electron app, so "not built" is the normal way to run it: electron-vite
  serves the renderer and the Electron binary in node_modules hosts the app. Nothing
  here produces an installer or a packaged executable.

  Two things this script exists to solve on Windows:

  1. Node version. The project declares engines.node 24, and Node 26 genuinely breaks
     the build: node-gyp derives build/config.gypi from the *running* Node's
     process.config.variables, and Node 26 reports enable_thin_lto=true / lto_jobs=2.
     On Windows that puts `-flto=thin` and `/opt:lldltojobs=2` on the MSVC linker
     command line, which dies with LNK1117 and leaves @orca/windows-registry, and with
     it `ensure:electron-runtime`, permanently unbuilt. This script pins a portable
     Node 24 that lives inside the project, so nothing global is installed and nothing
     on the machine is modified.

  2. pnpm. A bare `pnpm run <script>` re-enters the install, and the install fails on
     that same optional native module. Every step below therefore invokes the tool
     directly with the local Node, which is also why this does not shell out to pnpm.

.PARAMETER Action
  dev          Launch the dev app (default).
  doctor       Report prerequisites and the native-module check without launching.
  install      Re-run the native-module build for Electron, then exit.
  native       Re-run the native-module build for the local Node, then exit.
  install-node Download the pinned portable Node into tools\runtime, then exit.

.PARAMETER SkipWebBuild
  Skip the pairing web-client bundle build. The dev runner already skips it when the
  bundle is absent; this forces the skip when a stale bundle would otherwise trigger
  a rebuild.
#>
[CmdletBinding()]
param(
  [ValidateSet('dev', 'doctor', 'install', 'native', 'install-node')]
  [string]$Action = 'dev',

  [switch]$SkipWebBuild,

  [switch]$SkipNativeCheck
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = $ProjectRoot
$RuntimeRoot = Join-Path $PSScriptRoot 'runtime'
$NodeVersion = '24.21.0'
$NodeDir = Join-Path $RuntimeRoot "node-v$NodeVersion-win-x64"
$NodeExe = Join-Path $NodeDir 'node.exe'

function Write-Step($message) {
  Write-Host "[orca-dev] $message" -ForegroundColor Cyan
}

function Write-Warn($message) {
  Write-Host "[orca-dev] $message" -ForegroundColor Yellow
}

function Write-Fail($message) {
  Write-Host "[orca-dev] $message" -ForegroundColor Red
}

function Get-LocalNode {
  if (-not (Test-Path -LiteralPath $NodeExe)) {
    Write-Fail "Project-local Node v$NodeVersion is missing from $NodeDir"
    Write-Host "[orca-dev] Fetch it with:  .\tools\orca-dev.cmd install-node"
    exit 1
  }
  return $NodeExe
}

# Why the official win-x64 zip and not an installer or a version manager: it unpacks to
# a folder this project owns, touches no registry, PATH or global toolchain, and is
# removed by deleting that one directory.
function Install-LocalNode {
  if (Test-Path -LiteralPath $NodeExe) {
    Write-Step "Node v$NodeVersion already present"
    return
  }
  $url = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
  $archive = Join-Path ([System.IO.Path]::GetTempPath()) "node-v$NodeVersion-win-x64.zip"
  Write-Step "Downloading Node v$NodeVersion (portable zip)"
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing -TimeoutSec 900
  if (-not (Test-Path -LiteralPath $RuntimeRoot)) {
    New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
  }
  Write-Step 'Extracting into tools\runtime'
  Expand-Archive -Path $archive -DestinationPath $RuntimeRoot -Force
  Remove-Item -LiteralPath $archive -Force
  if (-not (Test-Path -LiteralPath $NodeExe)) {
    Write-Fail "Extraction did not produce $NodeExe"
    exit 1
  }
  Write-Step "Installed $((& $NodeExe --version))"
}

# Why here and not just for the node we spawn: Orca shells out to git, rg, pnpm and
# the agent CLIs, and they resolve through PATH. Prepending the local Node directory
# keeps the whole subtree on the pinned runtime instead of whatever the host has.
function Use-LocalNode {
  $node = Get-LocalNode
  $env:PATH = "$NodeDir;$env:PATH"
  $env:ORCA_NODE_DIR = $NodeDir
  return $node
}

function Assert-RepoPresent {
  if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'package.json'))) {
    Write-Fail "Orca sources are missing at $RepoRoot"
    exit 1
  }
}

function Invoke-Node {
  param(
    [Parameter(Mandatory = $true)][string]$Node,
    [Parameter(Mandatory = $true)][string]$Script,
    [string[]]$Arguments = @()
  )
  & $Node $Script @Arguments
  return $LASTEXITCODE
}

function Invoke-NativeRuntimeCheck {
  param([Parameter(Mandatory = $true)][string]$Node)

  Write-Step 'Checking native modules'
  & $Node (Join-Path $RepoRoot 'config\scripts\ensure-native-runtime.mjs') '--check-only'
  return $LASTEXITCODE
}

Assert-RepoPresent

switch ($Action) {
  'install-node' {
    Install-LocalNode
    exit 0
  }

  'doctor' {
    $node = Use-LocalNode
    Write-Step "Node         : $(& $node --version) ($NodeDir)"
    Write-Step "Repo         : $RepoRoot"
    Write-Step "Electron     : $((Get-Content (Join-Path $RepoRoot 'node_modules\electron\package.json') | ConvertFrom-Json).version)"
    $missing = @(
      'node_modules\electron\dist\electron.exe',
      'node_modules\electron-vite\bin\electron-vite.js',
      'node_modules\vite\bin\vite.js'
    ) | Where-Object { -not (Test-Path -LiteralPath (Join-Path $RepoRoot $_)) }
    if ($missing.Count -gt 0) {
      Write-Fail "Missing from node_modules: $($missing -join ', ')"
      exit 1
    }
    Write-Step 'Runtime deps : present'
    $code = Invoke-NativeRuntimeCheck -Node $node
    if ($code -ne 0) {
      Write-Fail 'Native modules are not built. Run: .\tools\orca-dev.cmd install'
      exit 1
    }
    Write-Step 'Native modules: OK'
    exit 0
  }

  'install' {
    $node = Use-LocalNode
    Write-Step 'Rebuilding native modules for Electron'
    Push-Location $RepoRoot
    try {
      & $node (Join-Path $RepoRoot 'config\scripts\rebuild-native-deps.mjs')
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
      Pop-Location
    }
    exit (Invoke-NativeRuntimeCheck -Node $node)
  }

  'native' {
    $node = Use-LocalNode
    Write-Step 'Rebuilding native modules for the local Node'
    Push-Location $RepoRoot
    try {
      & $node (Join-Path $RepoRoot 'config\scripts\ensure-native-runtime.mjs') '--runtime=node'
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
      Pop-Location
    }
    exit (Invoke-NativeRuntimeCheck -Node $node)
  }

  'dev' {
    $node = Use-LocalNode
    Write-Step "Node v$NodeVersion (project-local)"

    if (-not $SkipNativeCheck) {
      # Why gate the launch on this: without it Electron starts and then every
      # terminal pane fails to spawn a PTY, which looks like an Orca bug rather than a
      # build problem. Failing here names the real cause.
      $code = Invoke-NativeRuntimeCheck -Node $node
      if ($code -ne 0) {
        Write-Fail 'Native modules are not built for this runtime.'
        Write-Host "[orca-dev] Fix with:  .\tools\orca-dev.cmd install"
        exit $code
      }
    }

    if ($SkipWebBuild) {
      $env:ORCA_SKIP_DEV_WEB_PREPARE = '1'
    }

    Write-Step 'Starting Orca from source (no packaging, no .exe build)'
    Push-Location $RepoRoot
    try {
      & $node (Join-Path $RepoRoot 'config\scripts\run-electron-vite-dev.mjs') @args
      exit $LASTEXITCODE
    } finally {
      Pop-Location
    }
  }
}
