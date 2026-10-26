$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
node scripts/build-engine.cjs
if ($LASTEXITCODE -ne 0) { throw 'Engine build failed' }
