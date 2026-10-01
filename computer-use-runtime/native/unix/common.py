"""Private desktop worker protocol shared by macOS and Linux. No TCP listener."""
import base64
import hashlib
import json
import math
import os
import socket
import tempfile
import time
import uuid


def now():
    return int(time.time() * 1000)


class PreflightRejected(RuntimeError):
    """Only raised before backend.execute. No action input was dispatched."""
    def __init__(self, action, backend, reason):
        super().__init__(reason)
        self.receipt = {"actionId": action.get("id"), "runId": action.get("runId"),
                        "backend": backend, "phase": "rejected", "dispatched": False,
                        "delivered": False, "reason": reason}


class InputLock:
    def __init__(self, session):
        import fcntl
        self.fcntl = fcntl
        name = hashlib.sha256(session.encode()).hexdigest()[:24]
        path = os.path.join(tempfile.gettempdir(), f"cur-input-{os.getuid()}-{name}.lock")
        self.fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        if os.fstat(self.fd).st_uid != os.getuid():
            os.close(self.fd)
            raise RuntimeError("Input lock belongs to another user")

    def acquire(self):
        try:
            self.fcntl.flock(self.fd, self.fcntl.LOCK_EX | self.fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Desktop has another input owner") from None

    def release(self):
        self.fcntl.flock(self.fd, self.fcntl.LOCK_UN)

    def close(self):
        self.release()
        os.close(self.fd)


class Bridge:
    def __init__(self, backend, lock_factory=InputLock):
        self.backend = backend
        self.host = socket.gethostname()
        self.session = backend.session
        self.lock = lock_factory(self.session)
        self.owner = None
        self.generation = 0
        self.expires = 0
        self.manual = False
        self.target = None
        self.last = None
        if hasattr(backend, "on_portal_revoked"):
            backend.on_portal_revoked = self.portal_revoked

    def portal_revoked(self, _reason):
        self.last = None
        self.generation += 1
        portal = getattr(self.backend, "portal", None)
        if portal and portal.unsettled_inputs:
            self.manual = True
            self.expires = 0
            return
        self.owner = None
        self.lock.release()

    def release(self):
        try:
            self.backend.cleanup()
        except Exception as error:
            self.last = None
            self.manual = True
            self.expires = 0
            self.generation += 1
            raise RuntimeError("Input cleanup failed. Ownership stays quarantined until a release retry or confirmed session closure: " + str(error)) from error
        self.owner = None
        self.generation += 1
        self.lock.release()

    def window(self):
        if not self.target:
            raise RuntimeError("Bind an app window first")
        handle, pid = self.target
        windows = self.backend.window_state(handle) if hasattr(self.backend, "window_state") else self.backend.windows()
        matches = [w for w in windows if w["handle"] == handle and w["pid"] == pid]
        if len(matches) != 1:
            raise RuntimeError("The selected window closed or changed")
        return matches[0]

    def observe(self):
        self.last = None
        for _attempt in range(3):
            w = self.window()
            before = self.backend.controls(w)
            png = self.backend.capture(w)
            after = self.window()
            controls = self.backend.controls(after)
            if w["frame"] == after["frame"] and before == controls: break
        else: raise RuntimeError("Desktop content changed during observation; capture was not coherent")
        frame = w["frame"]
        data = json.dumps({"controls": controls, "frame": frame, "title": w["title"]}, sort_keys=True)
        self.last = {
            "schemaVersion": 1, "id": str(uuid.uuid4()), "host": self.host, "session": self.session,
            "target": str(w["handle"]), "at": now(), "revision": hashlib.sha256(data.encode() + (png or b"")).hexdigest(),
            "frame": frame, "focused": self.backend.focused(w), "controls": controls, "features": [],
            "facts": {"windowHandle": w["handle"], "windowTitle": w["title"], "desktopPlatform": self.backend.platform,
                      "supportedOperations": json.dumps(self.backend.operations), "supportedKeys": json.dumps(self.backend.keys),
                      "semanticBackground": True, "screenshotStatus": self.backend.screenshot_status},
            "backend": self.backend.name,
        }
        self.last["facts"].update(getattr(self.backend, "capture_facts", {}))
        return {**self.last, **({"png": base64.b64encode(png).decode()} if png else {})}

    def authorize(self, a):
        if self.manual or not self.owner or a.get("runId") != self.owner or a.get("generation") != self.generation or now() > self.expires:
            raise RuntimeError("Invalid input lease")
        o = self.last
        if not o or any(a.get(k) != o[k] for k in ("host", "session", "target", "revision", "frame")) or a.get("observationId") != o["id"]:
            raise RuntimeError("Observation or target mismatch")
        if now() - o["at"] > 2000 or now() > a.get("deadline", 0):
            raise RuntimeError("Action deadline or observation expired")
        op, args = a.get("operation"), a.get("args", {})
        if op not in self.backend.operations or a.get("scope") not in ("edit", "save"):
            raise RuntimeError("Operation or permission scope denied")
        if op == "key":
            key = args.get("key")
            if key not in self.backend.keys:
                raise RuntimeError("Unsupported key")
            if key in ("Control+S", "Control+Shift+S", "Meta+S", "Meta+Shift+S", "F12") and a["scope"] != "save":
                raise RuntimeError("Saving requires save permission")
        if op == "type":
            text = args.get("text")
            if not isinstance(text, str) or not 0 < len(text.encode()) <= 128 or any(ord(c) < 32 and c not in "\t\n" for c in text):
                raise RuntimeError("Invalid literal text")
        if op in ("click", "drag") or op == "hold" and "button" in args and ("x" in args or "y" in args):
            for x, y in [("x", "y")] + ([("dx", "dy")] if op == "drag" else []):
                if not all(isinstance(args.get(k), (int, float)) and math.isfinite(args[k]) for k in (x, y)) or not (0 <= args[x] < o["frame"]["width"] and 0 <= args[y] < o["frame"]["height"]):
                    raise RuntimeError("Point outside selected app")
        if op == "scroll" and (not isinstance(args.get("amount"), (int, float)) or not 0 < abs(args["amount"]) <= 1200):
            raise RuntimeError("Invalid scroll amount")
        if op == "hold":
            if isinstance(args.get("durationMs"), bool) or not isinstance(args.get("durationMs"), int) or not 1 <= args["durationMs"] <= 1000:
                raise RuntimeError("Invalid hold duration")
            if "key" in args:
                if args["key"] not in self.backend.keys: raise RuntimeError("Unsupported held key")
                if args["key"] in ("Control+S", "Control+Shift+S", "Meta+S", "Meta+Shift+S", "F12") and a["scope"] != "save": raise RuntimeError("Saving requires save permission")
            elif args.get("button") != "left": raise RuntimeError("Hold needs a supported key or left button")
        self.backend.capture_after = o["at"] if getattr(self.backend, "portal", None) and op in ("click", "drag", "key", "scroll", "hold") else None
        try: fresh = self.observe()
        finally: self.backend.capture_after = None
        self.last = None
        if fresh["revision"] != o["revision"] or fresh["frame"] != o["frame"]:
            raise RuntimeError("Desktop content changed after observation")
        if getattr(self.backend, "portal", None) and op in ("click", "drag", "key", "scroll", "hold"):
            facts = fresh["facts"]
            if facts.get("pixelFrameCached", True) or facts.get("pixelCapturedAt", 0) < o["at"] or not facts.get("pipewireSessionGeneration"):
                raise RuntimeError("Fresh portal pixels are unavailable; cached frames cannot authorize global input")
        if self.manual or self.owner != a.get("runId") or self.generation != a.get("generation") or now() > self.expires or now() > a["deadline"] or op not in self.backend.operations:
            raise RuntimeError("Input ownership or permission changed during preflight")
        w = self.window()
        if w["frame"] != o["frame"]:
            raise RuntimeError("Window moved after observation")
        if op not in ("invoke", "fill") and not self.backend.focused(w):
            raise RuntimeError("Input focus changed")
        if op in ("invoke", "fill", "type"):
            fresh = self.backend.controls(w)
            if op == "type":
                if not any(c["focused"] and c["controlType"] in (50004, 50030) for c in fresh):
                    raise RuntimeError("No focused editable control")
            else:
                locator = args.get("locator")
                match = [c for c in fresh if c["id"] == locator and not c["offscreen"] and op in c["actions"]]
                previous = [c for c in o["controls"] if c["id"] == locator]
                if len(match) != 1 or len(previous) != 1 or any(match[0][k] != previous[0][k] for k in ("name", "value", "controlType", "bounds")):
                    raise RuntimeError("Accessibility target changed")
                if op == "fill" and (not isinstance(args.get("value"), str) or len(args["value"]) > 8192):
                    raise RuntimeError("Invalid replacement text")
        return w

    def call(self, method, p):
        if hasattr(self.backend, "poll"): self.backend.poll()
        if method == "request_consent":
            if self.owner: raise RuntimeError("Release active desktop ownership before requesting portal consent")
            if not hasattr(self.backend, "request_consent"): raise RuntimeError("This platform does not use desktop portals")
            self.backend.close_portal()
            self.lock.acquire()
            try: return self.backend.request_consent(p.get("timeoutMs", 60000), getattr(self, "consent_cancelled", lambda: False))
            finally:
                self.last = None
                self.generation += 1
                self.lock.release()
        if method == "cancel_consent":
            if hasattr(self.backend, "close_portal"): self.backend.close_portal()
            return {"cancelled": True}
        if method == "capabilities":
            portal = getattr(self.backend, "portal", None)
            return {"host": self.host, "session": self.session, "platform": self.backend.platform,
                    "operations": self.backend.operations, "keys": self.backend.keys,
                    "screenshotStatus": self.backend.screenshot_status, "backend": self.backend.name,
                    "notes": self.backend.notes,
                    "consent": {"required": portal is not None, "granted": bool(portal and portal.active),
                                "pending": bool(portal and portal.pending), "devices": portal.devices if portal else 0,
                                "streams": len(portal.streams) if portal else 0},
                    "inputCleanup": {"settled": not portal or not portal.unsettled_inputs,
                                     "status": portal.cleanup_status if portal else "Backend cleanup result applies"}}
        if method == "windows":
            return self.backend.windows()
        if method == "bind":
            old = self.target
            self.target = (int(p["handle"]), int(p["pid"]))
            try:
                self.window()
            except Exception:
                self.target = old
                raise
            self.last = None
            return {"bound": True}
        if method == "focus":
            w = self.window()
            self.backend.focus(w)
            return {"focused": self.backend.focused(w)}
        if method == "observe":
            return self.observe()
        if method == "accessibility":
            return self.backend.controls(self.window())
        if method == "acquire":
            if self.manual:
                raise RuntimeError("Manual takeover active")
            if self.owner and self.owner != p["runId"] and now() < self.expires:
                raise RuntimeError("Desktop has another input owner")
            self.lock.acquire()
            self.owner = p["runId"]
            self.expires = now() + 30000
            self.generation += 1
            return {"generation": self.generation}
        if method == "release":
            if self.owner == p.get("runId"):
                self.release()
            return {}
        if method in ("stop", "takeover"):
            self.manual = True
            self.release()
            return {"manual": True, "heldInputsReleased": True}
        if method == "return":
            self.release()
            self.manual = False
            self.generation += 1
            return {}
        if method == "execute":
            try: w = self.authorize(p)
            except Exception as error:
                raise PreflightRejected(p, self.backend.name, str(error)) from error
            # Every input segment checks the deadline and target again.
            def guard():
                if getattr(self, "input_cancelled", lambda: False)():
                    raise RuntimeError("Input interrupted by stop, takeover or parent closure")
                if now() > p["deadline"] or now() > self.expires or self.window()["frame"] != p["frame"]:
                    raise RuntimeError("Input interrupted by deadline or target change")
                if self.manual or self.owner != p["runId"] or self.generation != p["generation"]:
                    raise RuntimeError("Input ownership changed")
                if p["operation"] not in ("invoke", "fill") and not self.backend.focused(w):
                    raise RuntimeError("Input interrupted by focus loss")
            try:
                self.backend.execute(w, p["operation"], p["args"], guard)
            finally:
                self.last = None
                try: self.backend.cleanup()
                except Exception as error:
                    self.manual = True
                    self.expires = 0
                    self.generation += 1
                    raise RuntimeError("Input cleanup failed. Ownership stays quarantined: " + str(error)) from error
            return {"actionId": p.get("id"), "runId": p.get("runId"), "backend": self.backend.name, "delivered": True}
        raise RuntimeError("Unsupported worker method")

    def close(self):
        try:
            self.release()
        finally:
            try: self.backend.close()
            finally: self.lock.close()


COMMON_KEYS = ["Enter", "Tab", "Shift+Tab", "Escape", "Space", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Backspace", "Delete", "F12"]
CONTROL_KEYS = ["Control+" + k for k in ("A", "C", "V", "Z", "F", "L", "O", "Tab", "Home", "End", "Shift+End", "N", "S", "Shift+S")]
META_KEYS = ["Meta+" + k for k in ("A", "C", "V", "Z", "F", "L", "O", "N", "S", "Shift+S", "ArrowLeft", "ArrowRight")]
