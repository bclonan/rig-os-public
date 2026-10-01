#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
test -x .venv/bin/python || python3 -m venv .venv
.venv/bin/python -m pip install -r learner/requirements.txt
printf '%s\n' 'Training runtime installed. Run .venv/bin/python learner/train.py'
