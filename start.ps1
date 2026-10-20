$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:PYTHONUTF8 = '1'
Write-Host 'Starting companion: http://127.0.0.1:8765'
Write-Host 'Keep this window open for proactive messages. Ctrl+C to stop.'
if (Get-Command python -ErrorAction SilentlyContinue) {
    & python -u app.py
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 -u app.py
} else {
    Write-Host 'Python 3.11+ is required. Install Python and run this file again.'
    exit 1
}
