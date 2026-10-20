$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
& .\.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --name chls-engine --onedir --distpath runtime --workpath build/engine --paths . --collect-all mitmproxy --collect-all mitmproxy_rs --collect-all mitmproxy_windows --collect-all uvicorn --collect-all websockets backend/entry.py
if ($LASTEXITCODE -ne 0) { throw 'Engine build failed' }
