#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
node -e 'const [major,minor]=process.versions.node.split(/\./).map(Number);if(major!==24||minor<17)process.exit(1)'
npm ci
npx playwright install chromium
npm run build
npm run cli -- schemas
npm run doctor
