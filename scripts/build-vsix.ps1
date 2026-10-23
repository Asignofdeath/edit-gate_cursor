#Requires -Version 5.1
<#
.SYNOPSIS
  Build Edit Gate UI VSIX into ..\vsix\
#>
$ErrorActionPreference = "Stop"
$Ui = Join-Path $PSScriptRoot "..\ui"
$VsixOut = Join-Path $PSScriptRoot "..\vsix"
New-Item -ItemType Directory -Force -Path $VsixOut | Out-Null

Push-Location $Ui
try {
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
  npm run package
  if ($LASTEXITCODE -ne 0) { throw "npm run package failed" }
  $built = Get-ChildItem -LiteralPath $Ui -Filter "edit-gate-ui-*.vsix" -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $built) { throw "VSIX not produced" }
  Copy-Item -LiteralPath $built.FullName -Destination (Join-Path $VsixOut $built.Name) -Force
  Write-Host "Copied $($built.Name) -> $VsixOut"
} finally {
  Pop-Location
}
