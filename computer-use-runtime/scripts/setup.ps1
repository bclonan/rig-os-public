$ErrorActionPreference='Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
node -e 'const [major,minor]=process.versions.node.split(/\./).map(Number);if(major!==24||minor<17)process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw 'Node 24 LTS is required' }
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
npx.cmd playwright install chromium
if ($LASTEXITCODE -ne 0) { throw 'Chromium setup failed' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
npm.cmd run cli -- schemas
if ($LASTEXITCODE -ne 0) { throw 'Schema generation failed' }
npm.cmd run doctor
if ($LASTEXITCODE -ne 0) { throw 'Doctor failed' }
Write-Output 'Start with npm start. Optional training dependencies: python -m pip install -r learner/requirements.txt'
