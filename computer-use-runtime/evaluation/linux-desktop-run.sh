#!/bin/sh
set -eu
export DISPLAY=:97
export NO_AT_BRIDGE=0
export GTK_MODULES=gail:atk-bridge
Xvfb "$DISPLAY" -screen 0 1280x900x24 -nolisten tcp >/tmp/cur-xvfb.log 2>&1 &
xvfb_pid=$!
trap 'kill "$xvfb_pid" 2>/dev/null || true' EXIT
sleep 1
dbus-run-session -- sh -c '
  openbox >/tmp/cur-openbox.log 2>&1 &
  /usr/bin/python3 evaluation/unix-desktop-fixture.py >/tmp/cur-gtk.log 2>&1 &
  sleep 2
  /usr/bin/python3 evaluation/unix-worker-live.py
  if [ -f node_modules/tsx/package.json ]; then
    node --import tsx evaluation/unix-runtime-live.ts
  fi
'
