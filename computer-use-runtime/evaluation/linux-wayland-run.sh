#!/bin/sh
set -eu
export XDG_RUNTIME_DIR="$(mktemp -d)"
chmod 700 "$XDG_RUNTIME_DIR"
export WAYLAND_DISPLAY=cur-test-wayland
export XDG_SESSION_TYPE=wayland
export GDK_BACKEND=wayland
export NO_AT_BRIDGE=0
unset DISPLAY
weston --backend=headless-backend.so --socket="$WAYLAND_DISPLAY" --idle-time=0 --width=1280 --height=900 >/tmp/cur-weston.log 2>&1 &
weston_pid=$!
trap 'kill "$weston_pid" 2>/dev/null || true' EXIT
sleep 2
dbus-run-session -- sh -c '
  /usr/bin/python3 evaluation/unix-desktop-fixture.py >/tmp/cur-wayland-gtk.log 2>&1 &
  sleep 2
  /usr/bin/python3 evaluation/wayland-worker-live.py
  if [ -f node_modules/tsx/package.json ]; then
    node --import tsx evaluation/unix-runtime-live.ts
  fi
'
