"""Real Mutter + GNOME portal test on a task-owned virtual desktop.

Consent uses the actual portal dialog. Effects come from separate GTK callbacks.
The fullscreen fixture gives a proven monitor origin for the initial profile.
"""
import base64
import hashlib
import json
import os
import queue
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

directory = Path(os.environ.get("EVIDENCE_DIR", "/evidence/mutter"))
report_name = os.environ.get("REPORT_NAME", "native-report.json")
os.environ["DBUS_SESSION_BUS_ADDRESS"] = (directory / "dbus-address").read_text().strip()
os.environ.update(XDG_RUNTIME_DIR=os.environ.get("XDG_RUNTIME_DIR", "/run/cur3"), XDG_SESSION_TYPE="wayland", WAYLAND_DISPLAY="cur-wayland", GDK_BACKEND="wayland", NO_AT_BRIDGE="0")
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi
Atspi.init(); Atspi.set_timeout(500, 1000)

responses = queue.Queue()
worker = subprocess.Popen(["/usr/bin/python3", "/workspace/native/unix/worker.py"], stdin=subprocess.PIPE,
    stdout=subprocess.PIPE, stderr=(directory / "worker.log").open("w"), text=True, bufsize=1)
def read_responses():
    for line in worker.stdout:
        try: responses.put(json.loads(line))
        except Exception: responses.put({"error": "Invalid worker response", "line": line})
threading.Thread(target=read_responses, daemon=True).start()
sequence = 0
def send(method, params=None):
    global sequence
    sequence += 1
    worker.stdin.write(json.dumps({"id": sequence, "method": method, "params": params or {}})+"\n")
    worker.stdin.flush(); return sequence
def receive(identifier, timeout=10):
    response = responses.get(timeout=timeout)
    if response.get("id") != identifier: raise RuntimeError("Unexpected response order: " + str(response))
    if "error" in response: raise RuntimeError(response["error"])
    return response["result"]
def rpc(method, params=None, timeout=10): return receive(send(method, params), timeout)
def owned_bus_pid(program):
    candidates = subprocess.check_output(["pgrep", "-f", "^"+program+"$"], text=True).strip().splitlines()
    expected = ("DBUS_SESSION_BUS_ADDRESS="+os.environ["DBUS_SESSION_BUS_ADDRESS"]).encode()
    for candidate in candidates:
        if expected in (Path("/proc") / candidate / "environ").read_bytes().split(b"\0"): return candidate
    raise RuntimeError("Task-owned private-bus process not found: " + program)

def nodes(node=None, depth=0):
    node = node or Atspi.get_desktop(0)
    if depth > 14: return
    yield node
    for i in range(min(node.get_child_count(), 100)):
        try: yield from nodes(node.get_child_at_index(i), depth+1)
        except Exception: pass
def tree():
    result = []
    for node in nodes():
        try:
            action = node.get_action_iface()
            result.append({"name": node.get_name(), "role": node.get_role_name(),
                "actions": [action.get_action_name(i) for i in range(action.get_n_actions())] if action else []})
        except Exception: pass
    return result
def click_named(name):
    for node in nodes():
        if node.get_name() not in (name, "_"+name+" "+name): continue
        action = node.get_action_iface()
        if action:
            for i in range(action.get_n_actions()):
                if action.get_action_name(i) in ("click", "activate", "toggle"):
                    if not action.do_action(i): raise RuntimeError("Dialog action rejected: " + name)
                    return True
    return False
def consent(accept=True, interaction=True):
    request = send("request_consent", {"timeoutMs": 15000})
    respond_dialog(accept, interaction)
    return receive(request, 20)
def respond_dialog(accept=True, interaction=True):
    deadline = time.monotonic()+10
    while time.monotonic() < deadline:
        items = tree()
        if any(item["name"] in ("Share", "Cancel") for item in items):
            (directory / ("consent-dialog.json" if accept else "cancel-dialog.json")).write_text(json.dumps(items, indent=2))
            if accept:
                # Select the actual owned monitor through its visible dialog row.
                monitor_names = [item["name"] for item in items if "Monitor" in item["name"] or "Meta-0" in item["name"]]
                for name in monitor_names: click_named(name)
                for node in nodes():
                    if node.get_role_name() == "check box" and node.get_name() == "Allow remote interaction" and node.get_state_set().contains(Atspi.StateType.CHECKED) != interaction:
                        node.get_action_iface().do_action(0)
            if click_named("Share" if accept else "Cancel"): break
        time.sleep(.05)
    else: raise RuntimeError("Actual GNOME consent dialog not selectable")
def direct_consent():
    sys.path.insert(0, "/workspace/native/unix")
    from portal import DesktopPortal
    dialog_errors = queue.Queue()
    def approve():
        try: respond_dialog()
        except Exception as error: dialog_errors.put(str(error))
    thread = threading.Thread(target=approve); thread.start()
    portal = DesktopPortal()
    grant = portal.request_consent(15000)
    thread.join(2)
    if not dialog_errors.empty(): raise RuntimeError(dialog_errors.get())
    return portal, grant
def pending_dialog():
    deadline = time.monotonic()+10
    while time.monotonic()<deadline:
        items = tree()
        if any(item["role"] == "push button" and "Cancel" in item["name"] for item in items):
            (directory / (report_name+".pending-dialog.json")).write_text(json.dumps(items, indent=2))
            return
        time.sleep(.02)
    raise RuntimeError("Pending real consent dialog was not shown")
def cancel_pending(method):
    request = send("request_consent", {"timeoutMs": 15000})
    pending_dialog(); started = time.monotonic()
    cancellation = send(method)
    response = responses.get(timeout=3)
    if response.get("id") != request or "cancelled" not in response.get("error", ""):
        raise AssertionError("Pending consent did not settle on " + method + ": " + str(response))
    result = receive(cancellation, 3)
    return {"elapsedMs": round((time.monotonic()-started)*1000), "request": response, "cancellation": result}

setup_portal = None
report = {"schemaVersion": 1, "evidenceKind": "native-disposable-wayland",
    "backend": "Mutter43.8 headless compositor + GNOME portal43.1", "checks": {}, "failures": [],
    "scope": "Owned single monitor, fullscreen repainting GTK fixture, scale1. Static frames are display-only and global input is safely rejected. No fractional-scale or arbitrary-window mapping claim"}
report["environment"] = {"python": sys.version, "packages": subprocess.check_output(["dpkg-query", "-W", "mutter", "xdg-desktop-portal", "xdg-desktop-portal-gnome", "pipewire", "libgtk-3-0", "libgtk-4-1", "gstreamer1.0-pipewire"], text=True).splitlines()}
setup_evidence = os.environ.get("SEAT_SETUP_EVIDENCE")
if setup_evidence:
    report["seatSetup"] = {"kind": "separate-actual-consent-portal", "artifact": setup_evidence,
        "detail": "Separate fixture setup sends Escape to initialize headless Mutter's absent physical keyboard. Claimed worker effects use only the worker's own granted session."}
def check(name, condition, evidence):
    report["checks"][name] = {"passed": bool(condition), "evidence": evidence}
    if not condition: raise AssertionError(name)
def state(): return json.loads((directory / "fixture-state.json").read_text())
def await_state(predicate):
    deadline = time.monotonic()+3
    while time.monotonic()<deadline:
        value = state()
        if predicate(value): return value
        time.sleep(.02)
    raise AssertionError("GTK callback effect did not occur: " + json.dumps(state()))
def action(operation, args):
    for attempt in range(4):
        observation = rpc("observe")
        lease = rpc("acquire", {"runId": "portal-native"})
        payload = {"id": "native-"+str(uuid.uuid4()), "runId": "portal-native", "generation": lease["generation"], "host": observation["host"],
            "session": observation["session"], "target": observation["target"], "observationId": observation["id"],
            "revision": observation["revision"], "frame": observation["frame"], "deadline": int(time.time()*1000)+10000,
            "scope": "edit", "operation": operation, "args": args}
        # A thrown RPC error is uncertain and never retried, even if its text
        # happens to match a preflight reason. Only a bound typed result is safe.
        result = rpc("execute", payload)
        if result.get("actionId") != payload["id"] or result.get("runId") != payload["runId"]:
            raise RuntimeError("Worker receipt did not bind this action and run")
        if result.get("phase") == "rejected":
            reason = result.get("reason")
            if result.get("dispatched") is not False or reason not in ("Desktop content changed after observation", "Fresh portal pixels are unavailable; cached frames cannot authorize global input") or attempt == 3:
                raise RuntimeError("Worker rejected action: " + str(reason))
            report.setdefault("preflightRefusals", []).append({"operation": operation, "attempt": attempt+1, "receipt":result, "observationFacts": observation["facts"]})
            time.sleep(.15); continue
        if result.get("delivered") is not True: raise RuntimeError("Worker receipt did not confirm bound delivery")
        return result
def center(name):
    controls = rpc("accessibility")
    control = next(item for item in controls if item["name"] == name)
    bounds = control["bounds"]
    return {"x": bounds["x"]+bounds["width"]/2, "y": bounds["y"]+bounds["height"]/2}

try:
    caps = rpc("capabilities")
    check("startup_no_global_grant", caps["operations"] == ["invoke", "fill", "type"] and not caps["keys"], caps)
    if os.environ.get("INITIALIZE_OWNED_VIRTUAL_SEAT") == "1":
        setup_portal, setup_grant = direct_consent()
        setup_portal.key(0xff1b, True); setup_portal.key(0xff1b, False)
        (directory / "fixture-present").touch(); time.sleep(.1)
        report["seatSetup"] = {"kind": "separate-actual-consent-portal", "grant": setup_grant,
            "detail": "Separate setup sends Escape then the owned fixture presents itself to initialize headless Mutter's absent physical keyboard. Claimed worker effects use only the worker's own granted session."}
    granted = consent()
    check("actual_consent", granted.get("granted") and granted.get("devices") == 3, granted)
    (directory / "fixture-present").touch()
    time.sleep(.1)
    windows = rpc("windows")
    window = next(item for item in windows if item["title"] == "Computer runtime portal fixture")
    rpc("bind", {"handle": window["handle"], "pid": window["pid"]})
    focus = rpc("focus")
    check("bound_window_focus", focus.get("focused"), {"focus": focus, "window": window})
    observation = rpc("observe")
    if "png" not in observation: raise AssertionError("No authorized frame: " + json.dumps(observation["facts"]))
    png = base64.b64decode(observation["png"])
    (directory / "authorized-fixture.png").write_bytes(png)
    from PIL import Image
    import io
    dimensions = Image.open(io.BytesIO(png)).size
    check("authorized_pipewire_capture", dimensions == (1280,900), {"dimensions": dimensions, "sha256": hashlib.sha256(png).hexdigest(), "frame": observation["frame"]})
    (directory / "fixture-static").touch(); time.sleep(.7)
    rpc("observe")  # Consume any final queued paint before checking silence.
    cached = rpc("observe"); cached_again = rpc("observe")
    prior = state(); lease = rpc("acquire", {"runId":"portal-native"})
    static_action = {"id":"static-frame-negative","runId":"portal-native","generation":lease["generation"],
        "host":cached_again["host"],"session":cached_again["session"],"target":cached_again["target"],
        "observationId":cached_again["id"],"revision":cached_again["revision"],"frame":cached_again["frame"],
        "deadline":int(time.time()*1000)+10000,"scope":"edit","operation":"click","args":center("Portal marker")}
    static_result = rpc("execute",static_action)
    static_caps = rpc("capabilities")
    check("static_cache_rejects_global_input_without_revoking_consent",
        cached["facts"].get("pixelFrameCached") and cached_again["facts"].get("pixelFrameCached") and
        cached["facts"].get("pixelCapturedAt") == cached_again["facts"].get("pixelCapturedAt") and
        cached["facts"].get("pixelFrameSequence") == cached_again["facts"].get("pixelFrameSequence") and
        static_result.get("phase") == "rejected" and static_result.get("dispatched") is False and
        static_result.get("actionId") == static_action["id"] and static_caps["consent"]["granted"] and
        state()["markerClicks"] == prior["markerClicks"],
        {"firstFacts":cached["facts"],"secondFacts":cached_again["facts"],"result":static_result,"consent":static_caps["consent"]})
    (directory / "fixture-static").unlink(); time.sleep(.15)
    marker = center("Portal marker")
    prior = state(); action("click", marker)
    value = await_state(lambda value: value["markerClicks"] > prior["markerClicks"])
    check("native_pointer_click", value["text"] == "Portal button verified" and value["markerClicks"] == prior["markerClicks"]+1, value)
    text = center("Portal text"); action("click", text)
    action("key", {"key": "Control+A"}); action("key", {"key": "Backspace"})
    value = await_state(lambda value: value["text"] == "")
    check("native_keyboard_effect", "BackSpace" in value["keyDown"] and "BackSpace" in value["keyUp"], value)
    canvas = center("Portal canvas"); prior = state()
    action("drag", {**canvas, "dx": canvas["x"]+80, "dy": canvas["y"]+40})
    value = await_state(lambda value: len(value["pointerMoves"]) > len(prior["pointerMoves"]) and value["pointerReleases"] > prior["pointerReleases"])
    check("native_drag", value["pointerReleases"] > prior["pointerReleases"], value)
    action("click", canvas); prior = state(); action("scroll", {"amount": 30})
    value = await_state(lambda value: value["scrollEvents"] > prior["scrollEvents"])
    check("native_scroll", True, value)
    action("click", text); prior = state(); action("hold", {"key": "ArrowRight", "durationMs": 80})
    value = await_state(lambda value: len(value["keyUp"]) > len(prior["keyUp"]))
    check("native_hold_cleanup", value["keyDown"].count("Right") == value["keyUp"].count("Right"), value)
    rpc("release", {"runId": "portal-native"}); rpc("cancel_consent")
    caps = rpc("capabilities")
    check("session_close_revokes_capabilities", caps["operations"] == ["invoke", "fill", "type"] and not caps["keys"], caps)
    try: consent(False)
    except RuntimeError as error:
        check("actual_cancel_denies", "denied or cancelled" in str(error), str(error))
    else: raise AssertionError("Cancel unexpectedly granted input")
    caps = rpc("capabilities")
    check("cancel_preserves_no_grant", caps["operations"] == ["invoke", "fill", "type"], caps)
    capture_only = consent(interaction=False)
    caps = rpc("capabilities")
    check("actual_partial_grant_capture_only", capture_only.get("granted") and capture_only.get("devices") == 0 and caps["operations"] == ["invoke", "fill", "type"] and not caps["keys"], {"grant": capture_only, "caps": caps})
    # Killing the task-owned backend closes real sessions, not a mocked signal.
    backend_pid = owned_bus_pid("/usr/libexec/xdg-desktop-portal-gnome")
    subprocess.run(["kill", "-TERM", backend_pid], check=True)
    time.sleep(.1)
    caps = rpc("capabilities")
    check("actual_backend_loss_revokes", not caps["consent"]["granted"] and caps["operations"] == ["invoke", "fill", "type"], caps)
    consent()
    front_pid = owned_bus_pid("/usr/libexec/xdg-desktop-portal")
    subprocess.run(["kill", "-TERM", front_pid], check=True)
    time.sleep(.1)
    caps = rpc("capabilities")
    check("actual_dbus_owner_loss_revokes", not caps["consent"]["granted"] and not caps["keys"], caps)
    cancelled = cancel_pending("cancel_consent")
    check("actual_request_close_settles_without_response", cancelled["elapsedMs"] < 2000, cancelled)
    interrupted = cancel_pending("takeover")
    check("actual_takeover_cancels_pending_consent", interrupted["elapsedMs"] < 2000, interrupted)
    rpc("return")
    send("request_consent", {"timeoutMs": 15000}); pending_dialog(); started = time.monotonic()
    worker.stdin.close(); worker.wait(timeout=3)
    check("actual_parent_eof_cancels_pending_consent", worker.returncode == 0, {"elapsedMs": round((time.monotonic()-started)*1000), "exitCode": worker.returncode})
    # Exercise the real incoming Session.Closed signal on an owned portal client.
    signal_portal, signal_grant = direct_consent()
    try:
        # PipeWire core loss makes Mutter close its session gracefully.
        pipewire_pid = None
        for candidate in subprocess.check_output(["pgrep", "-x", "pipewire"], text=True).strip().splitlines():
            if ("XDG_RUNTIME_DIR="+os.environ["XDG_RUNTIME_DIR"]).encode() in (Path("/proc") / candidate / "environ").read_bytes().split(b"\0"): pipewire_pid = candidate; break
        if not pipewire_pid: raise RuntimeError("Task-owned PipeWire process not found")
        subprocess.run(["kill", "-TERM", pipewire_pid], check=True)
        deadline = time.monotonic()+3
        while "Session.Closed signal" not in signal_portal.status and time.monotonic() < deadline:
            signal_portal.pump(); time.sleep(.01)
        check("actual_session_closed_signal", not signal_portal.active and "Session.Closed signal" in signal_portal.status, {"grant": signal_grant, "status": signal_portal.status, "trigger": "Task-owned PipeWire core shutdown"})
    finally: signal_portal.close()
except Exception as error:
    report["failures"].append({"type": type(error).__name__, "message": str(error)})
finally:
    if setup_portal: setup_portal.close()
    try: worker.stdin.close(); worker.wait(timeout=5)
    except Exception: worker.terminate()
    report["passed"] = not report["failures"] and all(item["passed"] for item in report["checks"].values())
    source_paths = [Path("/workspace/native/unix") / name for name in ("portal.py", "common.py", "linux.py", "worker.py")]
    source_paths += [Path("/workspace/evaluation") / name for name in ("linux-portal-native.py", "linux-portal-fixture.py", "linux-portal-session.sh")]
    report["sourceSha256"] = {str(path.relative_to(Path("/workspace"))): hashlib.sha256(path.read_bytes()).hexdigest() for path in source_paths}
    (directory / report_name).write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    sys.exit(0 if report["passed"] else 1)
