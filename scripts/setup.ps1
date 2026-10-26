$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
node scripts/setup.cjs
if ($LASTEXITCODE -ne 0) { throw 'Setup failed' }
