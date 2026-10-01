"""Real Wayland GTK accessibility test. No X11 fallback or input injection."""
import json
import os
from pathlib import Path
import subprocess
import time
import uuid
root = Path(__file__).resolve().parent.parent
worker = subprocess.Popen(["/usr/bin/python3", "-u", str(root/"native/unix/worker.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
seq = 0
def call(method, params=None):
    global seq
    seq += 1
    worker.stdin.write(json.dumps({"id":seq, "method":method, "params":params or {}})+"\n"); worker.stdin.flush()
    response=json.loads(worker.stdout.readline())
    if "error" in response: raise RuntimeError(response["error"])
    return response["result"]
def act(op, args):
    o=call("observe")
    generation=call("acquire", {"runId":"test"})["generation"]
    call("execute", {"runId":"test", "generation":generation, "host":o["host"], "session":o["session"], "target":o["target"], "observationId":o["id"], "revision":o["revision"], "frame":o["frame"], "deadline":int(time.time()*1000)+10000, "scope":"edit", "operation":op, "args":args})
report={"status":"NOT RUN", "evidenceLevel":"real Weston Wayland compositor, native Wayland GTK app, AT-SPI2 actions"}
try:
    caps=call("capabilities")
    assert caps["backend"] == "linux-atspi-wayland"
    assert "click" not in caps["operations"] and "key" not in caps["operations"]
    target=next(w for w in call("windows") if w["title"] == "Computer runtime disposable editor")
    call("bind", {"handle":target["handle"], "pid":target["pid"]})
    o=call("observe")
    assert "png" not in o
    editor=next(c for c in o["controls"] if c["name"] == "Test text")
    act("fill", {"locator":editor["id"], "value":"Wayland native text ✓"})
    o=call("observe")
    assert next(c for c in o["controls"] if c["name"] == "Test text")["value"] == "Wayland native text ✓"
    button=next(c for c in o["controls"] if c["name"] == "Write marker" and "invoke" in c["actions"])
    act("invoke", {"locator":button["id"]})
    time.sleep(.1)
    o=call("observe")
    assert next(c for c in o["controls"] if c["name"] == "Test text")["value"] == "Button verified"
    report.update(status="PASS", checks=["Wayland app enumeration", "Unicode fill", "button invocation effect", "no X11 fallback", "unsupported pointer and capture are absent"])
except Exception as e:
    report.update(status="FAIL", error=repr(e)); raise
finally:
    worker.stdin.close(); worker.wait(timeout=5)
    report["workerExit"]=worker.returncode
    (root/"evidence/linux-wayland.json").write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))
