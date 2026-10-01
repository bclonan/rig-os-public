"""Inspect the actual disposable portal UI. This does not supply portal grants."""
import json
import os
import sys
import time
from pathlib import Path

directory = Path(os.environ.get("EVIDENCE_DIR", "/evidence/mutter"))
os.environ["DBUS_SESSION_BUS_ADDRESS"] = (directory / "dbus-address").read_text().strip()
os.environ.update(XDG_RUNTIME_DIR=os.environ.get("XDG_RUNTIME_DIR", "/run/cur3"), XDG_SESSION_TYPE="wayland", WAYLAND_DISPLAY="cur-wayland", GDK_BACKEND="wayland", NO_AT_BRIDGE="0")
sys.path.insert(0, "/workspace/native/unix")
if sys.argv[1:] in (["prompt"], ["bootstrap"]):
    from portal import DesktopPortal
    portal = DesktopPortal()
    try:
        print(json.dumps(portal.request_consent()), flush=True)
        if sys.argv[1:] == ["bootstrap"]:
            # Test setup for Mutter headless's absent physical keyboard. This is
            # an actual separately consented portal, never a bypass of Bridge.
            portal.key(0xff1b, True); portal.key(0xff1b, False)
            time.sleep(180)
    finally: portal.close()
elif sys.argv[1:] == ["windows"]:
    from linux import LinuxDesktop
    desktop = LinuxDesktop()
    try: print(json.dumps(desktop.windows()))
    finally: desktop.close()
else:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
    Atspi.init(); Atspi.set_timeout(500, 1000)
    def inspect(node, depth=0):
        if depth > 12: return
        try:
            action = node.get_action_iface()
            if sys.argv[1:] == ["share"]:
                if node.get_name() == "Allow remote interaction" and node.get_role_name() == "check box" and not node.get_state_set().contains(Atspi.StateType.CHECKED): action.do_action(0)
                if node.get_name() == "_Share Share" and node.get_role_name() == "push button": action.do_action(0)
            print(json.dumps({"depth": depth, "name": node.get_name(), "role": node.get_role_name(),
                "states": [str(item) for item in node.get_state_set().get_states()],
                "actions": [action.get_action_name(i) for i in range(action.get_n_actions())] if action else []}), flush=True)
            for i in range(min(node.get_child_count(), 100)): inspect(node.get_child_at_index(i), depth+1)
        except Exception: pass
    inspect(Atspi.get_desktop(0))
