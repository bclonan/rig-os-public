"""Exercise the real Linux worker against the disposable GTK editor."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

root = Path(__file__).resolve().parent.parent
worker = subprocess.Popen(["/usr/bin/python3", "-u", str(root / "native/unix/worker.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
seq = 0
report = {"status": "NOT RUN", "evidenceLevel": "real Linux X11 virtual display, AT-SPI GTK app and private worker", "checks": []}
def call(method, params=None):
    global seq
    seq += 1
    worker.stdin.write(json.dumps({"id": seq, "method": method, "params": params or {}}) + "\n")
    worker.stdin.flush()
    line = worker.stdout.readline()
    if not line:
        raise RuntimeError("Worker exited")
    result = json.loads(line)
    if "error" in result:
        raise RuntimeError(result["error"])
    return result["result"]
def action(operation, args, o=None):
    o = o or call("observe")
    generation = call("acquire", {"runId": "live-test"})["generation"]
    return call("execute", {"schemaVersion": 1, "id": str(uuid.uuid4()), "runId": "live-test", "requester": "test", "host": o["host"], "session": o["session"], "target": o["target"], "observationId": o["id"], "revision": o["revision"], "frame": o["frame"], "operation": operation, "args": args, "scope": "edit", "deadline": int(time.time()*1000)+10000, "generation": generation})
try:
    caps = call("capabilities")
    report["backend"] = caps["backend"]
    target = None
    for _ in range(50):
        windows = call("windows")
        target = next((w for w in windows if w["title"] == "Computer runtime disposable editor"), None)
        if target: break
        time.sleep(.1)
    assert target, "Fixture window found"
    call("bind", {"handle": target["handle"], "pid": target["pid"]})
    assert call("focus")["focused"]
    o = call("observe")
    Path("/tmp/unix-observation.json").write_text(json.dumps(o))
    assert base64.b64decode(o["png"]).startswith(b"\x89PNG\r\n\x1a\n")
    editor = next(c for c in o["controls"] if c["name"] == "Test text")
    assert "fill" in editor["actions"]
    action("fill", {"locator": editor["id"], "value": "Native Linux verified. café ✓"}, o)
    o = call("observe")
    assert next(c for c in o["controls"] if c["name"] == "Test text")["value"] == "Native Linux verified. café ✓"
    button = next(c for c in o["controls"] if c["name"] == "Write marker" and "invoke" in c["actions"])
    action("invoke", {"locator": button["id"]}, o)
    time.sleep(.1)
    o = call("observe")
    assert next(c for c in o["controls"] if c["name"] == "Test text")["value"] == "Button verified"
    editor = next(c for c in o["controls"] if c["name"] == "Test text")
    b, f = editor["bounds"], o["frame"]
    action("click", {"x": round(b["x"]+b["width"]/2-f["x"]), "y": round(b["y"]+b["height"]/2-f["y"])}, o)
    action("key", {"key": "Control+A"})
    action("type", {"text": "Typed in Linux ✓"})
    o = call("observe")
    assert next(c for c in o["controls"] if c["name"] == "Test text")["value"] == "Typed in Linux ✓"
    call("takeover")
    try:
        call("acquire", {"runId": "live-test"})
        raise AssertionError("Takeover must reject acquisition")
    except RuntimeError as error:
        assert "takeover" in str(error)
    call("return")
    call("acquire", {"runId": "live-test"})
    call("release", {"runId": "live-test"})
    report.update(status="PASS", checks=["real app enumeration", "PID binding", "focus", "PNG capture", "AT-SPI controls", "Unicode text replacement", "button effect", "XTEST click and shortcut", "literal text insertion", "takeover and return"])
except Exception as e:
    report.update(status="FAIL", error=repr(e))
    raise
finally:
    worker.stdin.close()
    worker.wait(timeout=5)
    report["workerExit"] = worker.returncode
    (root / "evidence/linux-native.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
