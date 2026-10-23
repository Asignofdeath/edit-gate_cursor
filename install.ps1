#Requires -Version 5.1
<#
.SYNOPSIS
  Safely install Edit Gate for Cursor (Windows): MCP + hooks + UI extension.

.DESCRIPTION
  Writes ONLY under %USERPROFILE%\.cursor\
  - Backs up hooks.json and mcp.json before changes
  - Merges the edit-gate MCP server (does not remove other MCP servers)
  - Replaces hooks.json with Edit Gate hooks AFTER backup (see README)
  - Never runs recursive deletes outside the installer package / temp preserve folder

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Yes
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$SkipExtension,
  [switch]$SkipNpm
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$CursorHome = Join-Path $env:USERPROFILE ".cursor"
$RuntimeEditGate = Join-Path $Root "runtime\edit-gate"
$RuntimeHooks = Join-Path $Root "runtime\hooks"
$VsixDir = Join-Path $Root "vsix"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name. Install it and reopen the terminal."
  }
}

function Get-CursorCli {
  $cmd = Get-Command cursor -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\cursor\resources\app\bin\cursor.cmd"),
    (Join-Path ${env:ProgramFiles} "Cursor\resources\app\bin\cursor.cmd")
  )
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  throw "Cursor CLI not found. Install Cursor, then reopen PowerShell."
}

function Backup-File([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $backup = "$Path.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $Path -Destination $backup -Force
  Write-Host "Backup: $backup"
  return $backup
}

function Merge-EditGateMcp([string]$McpPath, [string]$ServerPath) {
  $map = @{}
  if (Test-Path -LiteralPath $McpPath) {
    $raw = Get-Content -LiteralPath $McpPath -Raw -Encoding UTF8
    if ($raw -and $raw.Trim()) {
      $parsed = $raw | ConvertFrom-Json
      if ($parsed.mcpServers) {
        foreach ($p in $parsed.mcpServers.PSObject.Properties) {
          $map[$p.Name] = $p.Value
        }
      }
    }
  }
  $map["edit-gate"] = @{
    command = "node"
    args    = @($ServerPath)
  }
  $doc = @{ mcpServers = $map }
  $json = $doc | ConvertTo-Json -Depth 30
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($McpPath, $json + "`n", $utf8)
}

function Write-EditGateHooks([string]$HooksJsonPath, [string]$HooksDir) {
  $gate = ((Join-Path $HooksDir "gate-edits.mjs") -replace "/", "\")
  $clear = ((Join-Path $HooksDir "clear-approval.mjs") -replace "/", "\")
  $gateCmd = "cmd /c node `"$gate`""
  $clearCmd = "cmd /c node `"$clear`""

  $hooks = @{
    version = 1
    hooks   = @{
      preToolUse = @(
        @{
          command    = $gateCmd
          matcher    = "Write|StrReplace|Delete|EditNotebook|Shell"
          failClosed = $true
          timeout    = 15
        }
      )
      beforeShellExecution = @(
        @{
          command    = $gateCmd
          failClosed = $true
          timeout    = 15
        }
      )
      stop = @(
        @{
          command = $clearCmd
          timeout = 10
        }
      )
      sessionEnd = @(
        @{
          command = $clearCmd
          timeout = 10
        }
      )
    }
  }

  $json = $hooks | ConvertTo-Json -Depth 30
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($HooksJsonPath, $json + "`n", $utf8)
}

function Copy-RuntimeSources([string]$SrcDir, [string]$DestDir, [string[]]$Names) {
  New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
  foreach ($name in $Names) {
    $from = Join-Path $SrcDir $name
    if (-not (Test-Path -LiteralPath $from)) {
      throw "Missing package file: $from"
    }
    Copy-Item -LiteralPath $from -Destination (Join-Path $DestDir $name) -Force
  }
}

# --- preflight ---
Write-Host "Edit Gate installer"
Write-Host "Package: $Root"
Write-Host "Target:  $CursorHome (USERPROFILE only)"
Write-Host ""

if (-not (Test-Path -LiteralPath $RuntimeEditGate)) { throw "Missing runtime\edit-gate" }
if (-not (Test-Path -LiteralPath $RuntimeHooks)) { throw "Missing runtime\hooks" }

Write-Host "This installer will:"
Write-Host "  1) Copy MCP runtime -> $CursorHome\edit-gate"
Write-Host "  2) Copy hooks       -> $CursorHome\hooks"
Write-Host "  3) Backup + write hooks.json (Edit Gate standard hooks)"
Write-Host "  4) Backup + merge mcp.json (add/update edit-gate only)"
if (-not $SkipExtension) {
  Write-Host "  5) Install Edit Gate UI from vsix\"
}
Write-Host ""
Write-Host "It will NOT delete your projects or wipe disks."
Write-Host ""
Write-Host "DISCLAIMER: Software is provided AS IS. Authors are not liable for data loss," -ForegroundColor DarkYellow
Write-Host "damages, or misuse. See DISCLAIMER.md. Continue only if you accept that." -ForegroundColor DarkYellow
Write-Host ""

if (-not $Yes) {
  $ans = Read-Host "Continue? [y/N]"
  if ($ans -notmatch '^(y|yes)$') {
    Write-Host "Cancelled."
    exit 0
  }
}

Assert-Command node
Assert-Command npm
$CursorCli = $null
if (-not $SkipExtension) {
  $CursorCli = Get-CursorCli
  Write-Host "Cursor CLI: $CursorCli"
}

New-Item -ItemType Directory -Force -Path $CursorHome | Out-Null

# --- runtime ---
Write-Step "Install Edit Gate MCP runtime"
$destEditGate = Join-Path $CursorHome "edit-gate"
$destHooks = Join-Path $CursorHome "hooks"

# Preserve local state
$preserveNames = @("approval.json", "pending.json", "delete-burst.json", "ghost-nudge.json", "config.json")
$tempPreserve = Join-Path $env:TEMP ("edit-gate-preserve-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempPreserve | Out-Null
try {
  if (Test-Path -LiteralPath $destEditGate) {
    foreach ($f in $preserveNames) {
      $p = Join-Path $destEditGate $f
      if (Test-Path -LiteralPath $p) {
        Copy-Item -LiteralPath $p -Destination (Join-Path $tempPreserve $f) -Force
      }
    }
  }

  Copy-RuntimeSources -SrcDir $RuntimeEditGate -DestDir $destEditGate -Names @(
    "server.mjs",
    "approval-store.mjs",
    "delete-policy.mjs",
    "delete-burst.mjs",
    "package.json",
    "package-lock.json",
    "config.default.json"
  )

  foreach ($f in $preserveNames) {
    $saved = Join-Path $tempPreserve $f
    if (Test-Path -LiteralPath $saved) {
      Copy-Item -LiteralPath $saved -Destination (Join-Path $destEditGate $f) -Force
    }
  }
} finally {
  # Only remove our temp preserve folder under %TEMP%
  if (Test-Path -LiteralPath $tempPreserve) {
    Remove-Item -LiteralPath $tempPreserve -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$cfgPath = Join-Path $destEditGate "config.json"
if (-not (Test-Path -LiteralPath $cfgPath)) {
  $defaultCfg = Join-Path $destEditGate "config.default.json"
  Copy-Item -LiteralPath $defaultCfg -Destination $cfgPath -Force
  Write-Host "Created config.json from defaults"
}

if (-not $SkipNpm) {
  Write-Host "npm install --omit=dev in $destEditGate"
  Push-Location $destEditGate
  try {
    npm install --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}

# --- hooks scripts ---
Write-Step "Install hook scripts"
Copy-RuntimeSources -SrcDir $RuntimeHooks -DestDir $destHooks -Names @(
  "gate-edits.mjs",
  "clear-approval.mjs"
)

# --- hooks.json ---
Write-Step "Write hooks.json (with backup)"
$hooksJson = Join-Path $CursorHome "hooks.json"
Backup-File -Path $hooksJson | Out-Null
Write-EditGateHooks -HooksJsonPath $hooksJson -HooksDir $destHooks
Write-Host "Wrote $hooksJson"

# --- mcp.json ---
Write-Step "Merge mcp.json (with backup)"
$mcpPath = Join-Path $CursorHome "mcp.json"
Backup-File -Path $mcpPath | Out-Null
$serverPath = Join-Path $destEditGate "server.mjs"
Merge-EditGateMcp -McpPath $mcpPath -ServerPath $serverPath
Write-Host "Merged edit-gate into $mcpPath"

# --- extension ---
if (-not $SkipExtension) {
  Write-Step "Install Edit Gate UI"
  if (-not (Test-Path -LiteralPath $VsixDir)) {
    throw "Missing vsix\ folder"
  }
  $vsixFiles = @(Get-ChildItem -LiteralPath $VsixDir -Filter "*.vsix" -File)
  if ($vsixFiles.Count -lt 1) {
    throw "No .vsix in vsix\. Build UI first (see README)."
  }
  foreach ($vsix in $vsixFiles) {
    Write-Host "Installing $($vsix.Name) ..."
    & $CursorCli --install-extension $vsix.FullName --force
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to install $($vsix.Name) (exit $LASTEXITCODE)"
    }
  }
}

Write-Step "Done"
Write-Host @"

Installed under: $CursorHome
  edit-gate\   (MCP)
  hooks\       (gate-edits / clear-approval)
  hooks.json
  mcp.json     (edit-gate entry merged)

Next:
  1) Fully quit Cursor (including tray) and reopen
  2) Settings: editGate.enabled = true
  3) Confirm MCP "edit-gate" tools: request_edit_approval, request_batch_delete
  4) Optional: copy rules\require-edit-approval.mdc into your project's .cursor\rules\

"@
