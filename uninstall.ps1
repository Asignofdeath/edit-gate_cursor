#Requires -Version 5.1
<#
.SYNOPSIS
  Remove Edit Gate entries installed by install.ps1 (Windows / current user only).

.DESCRIPTION
  - Backs up hooks.json and mcp.json
  - Removes edit-gate from mcp.json (keeps other servers)
  - Removes Edit Gate hook scripts and optionally the edit-gate runtime folder
  - Does NOT uninstall other MCP servers or wipe disks
  - Does NOT remove the VSIX unless -RemoveExtension is set

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Yes
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$RemoveExtension,
  [switch]$KeepRuntime
)

$ErrorActionPreference = "Stop"
$CursorHome = Join-Path $env:USERPROFILE ".cursor"

function Backup-File([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $backup = "$Path.bak-uninstall-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $Path -Destination $backup -Force
  Write-Host "Backup: $backup"
}

Write-Host "Edit Gate uninstaller"
Write-Host "Target: $CursorHome"
Write-Host "Will remove Edit Gate MCP entry, hook scripts, and (unless -KeepRuntime) edit-gate folder."
Write-Host ""

if (-not $Yes) {
  $ans = Read-Host "Continue? [y/N]"
  if ($ans -notmatch '^(y|yes)$') {
    Write-Host "Cancelled."
    exit 0
  }
}

$mcpPath = Join-Path $CursorHome "mcp.json"
if (Test-Path -LiteralPath $mcpPath) {
  Backup-File $mcpPath
  $raw = Get-Content -LiteralPath $mcpPath -Raw -Encoding UTF8
  $parsed = $raw | ConvertFrom-Json
  $map = @{}
  if ($parsed.mcpServers) {
    foreach ($p in $parsed.mcpServers.PSObject.Properties) {
      if ($p.Name -ne "edit-gate") { $map[$p.Name] = $p.Value }
    }
  }
  $doc = @{ mcpServers = $map }
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($mcpPath, (($doc | ConvertTo-Json -Depth 30) + "`n"), $utf8)
  Write-Host "Removed edit-gate from mcp.json"
}

$hooksJson = Join-Path $CursorHome "hooks.json"
if (Test-Path -LiteralPath $hooksJson) {
  Backup-File $hooksJson
  # Leave an empty hooks skeleton so Cursor does not break; user can restore from .bak
  $empty = "{`n  `"version`": 1,`n  `"hooks`": {}`n}`n"
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($hooksJson, $empty, $utf8)
  Write-Host "Reset hooks.json to empty hooks (restore from .bak if you had others)"
}

$hooksDir = Join-Path $CursorHome "hooks"
foreach ($f in @("gate-edits.mjs", "clear-approval.mjs")) {
  $p = Join-Path $hooksDir $f
  if (Test-Path -LiteralPath $p) {
    Remove-Item -LiteralPath $p -Force
    Write-Host "Removed $p"
  }
}

if (-not $KeepRuntime) {
  $eg = Join-Path $CursorHome "edit-gate"
  if (Test-Path -LiteralPath $eg) {
    # Only remove known Edit Gate runtime directory under .cursor
    Remove-Item -LiteralPath $eg -Recurse -Force
    Write-Host "Removed $eg"
  }
}

if ($RemoveExtension) {
  $cursor = Get-Command cursor -ErrorAction SilentlyContinue
  if ($cursor) {
    & cursor --uninstall-extension local.edit-gate-ui
    Write-Host "Requested uninstall of local.edit-gate-ui"
  } else {
    Write-Host "cursor CLI not found; uninstall the Edit Gate UI extension manually."
  }
}

Write-Host "Done. Fully quit and reopen Cursor."
