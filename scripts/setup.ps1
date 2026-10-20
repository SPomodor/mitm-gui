$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) { python -m venv .venv }
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt pyinstaller
if ($LASTEXITCODE -ne 0) { throw 'Python dependencies failed' }
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Node dependencies failed' }
Write-Host 'Ready. Run npm run dev'
