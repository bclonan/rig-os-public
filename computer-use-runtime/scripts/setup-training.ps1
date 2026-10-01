$ErrorActionPreference='Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (!(Test-Path '.venv/Scripts/python.exe')) {
  python -m venv .venv
  if ($LASTEXITCODE -ne 0) { throw 'Python virtual environment creation failed' }
}
& .venv/Scripts/python.exe -m pip install -r learner/requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Training dependency installation failed' }
Write-Output 'Training runtime installed. Run .venv/Scripts/python.exe learner/train.py'
