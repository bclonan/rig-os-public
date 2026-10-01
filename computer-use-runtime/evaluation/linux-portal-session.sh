#!/bin/sh
# Disposable real GNOME/Mutter portal session, without XWayland.
set -eu
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/cur}
export XDG_CURRENT_DESKTOP=GNOME
export XDG_SESSION_DESKTOP=gnome
export XDG_SESSION_TYPE=wayland
export WAYLAND_DISPLAY=cur-wayland
export LIBGL_ALWAYS_SOFTWARE=1
export NO_AT_BRIDGE=0
export GTK_A11Y=atspi
export GDK_BACKEND=wayland
evidence_dir=${EVIDENCE_DIR:-/evidence}
export EVIDENCE_DIR="$evidence_dir"
mkdir -p "$XDG_RUNTIME_DIR" "$evidence_dir"
chmod 700 "$XDG_RUNTIME_DIR"
printf '%s\n' "$DBUS_SESSION_BUS_ADDRESS" > "$evidence_dir/dbus-address"
pipewire > "$evidence_dir/pipewire.log" 2>&1 &
wireplumber > "$evidence_dir/wireplumber.log" 2>&1 &
${COMPOSITOR:-gnome-shell} --wayland --headless --no-x11 --virtual-monitor=1280x900 --wayland-display=cur-wayland > "$evidence_dir/compositor.log" 2>&1 &
for attempt in $(seq 1 100); do
  [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && break
  sleep .1
done
[ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] || { cat "$evidence_dir/compositor.log"; exit 2; }
dbus-update-activation-environment XDG_RUNTIME_DIR XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP XDG_SESSION_TYPE WAYLAND_DISPLAY GDK_BACKEND GTK_A11Y NO_AT_BRIDGE
/usr/libexec/xdg-desktop-portal-gnome > "$evidence_dir/portal-gnome.log" 2>&1 &
/usr/libexec/xdg-desktop-portal > "$evidence_dir/portal.log" 2>&1 &
/usr/bin/python3 /workspace/evaluation/linux-portal-fixture.py > "$evidence_dir/fixture.log" 2>&1 &
touch "$evidence_dir/session-ready"
wait
