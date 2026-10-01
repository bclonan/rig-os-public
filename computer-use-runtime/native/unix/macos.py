"""macOS Accessibility, Quartz input and ScreenCaptureKit window screenshots.

Requires macOS 14+ and user-granted Accessibility permission. Screen Recording
is optional for accessibility-only work and required for screenshots.
"""
import math
import os
import platform
import threading
import time
from common import COMMON_KEYS, CONTROL_KEYS, META_KEYS


class MacDesktop:
    platform = "macOS"
    name = "macos-ax-screencapturekit"
    def __init__(self):
        import AppKit
        import Quartz
        import HIServices
        import ScreenCaptureKit
        import Foundation
        if int(platform.mac_ver()[0].split(".")[0]) < 14:
            raise RuntimeError("macOS 14 or newer is required for ScreenCaptureKit screenshots")
        self.K, self.Q, self.A, self.S, self.F = AppKit, Quartz, HIServices, ScreenCaptureKit, Foundation
        if not HIServices.AXIsProcessTrusted():
            raise RuntimeError("Grant Accessibility access to the terminal or Python app running this service in System Settings > Privacy & Security > Accessibility, then restart")
        self.session = f"macos-{os.getuid()}-console"
        can_post = bool(Quartz.CGPreflightPostEventAccess())
        self.operations = ["invoke", "fill"] + (["click", "type", "key", "scroll", "drag"] if can_post else [])
        self.keys = COMMON_KEYS + CONTROL_KEYS + META_KEYS if can_post else []
        self.screenshot_status = "ScreenCaptureKit" if Quartz.CGPreflightScreenCaptureAccess() else "Screen Recording permission is not granted; accessibility controls only"
        self.notes = "Grant Screen Recording permission to the service's terminal/Python app for screenshots. Command shortcuts use Meta. Secure fields are excluded."
        if not can_post:
            self.notes += " Quartz input permission is unavailable; only bound accessibility actions are enabled."
        self.refs = {}
        self.held_keys = set()
        self.held_mouse = False
        self.last_point = (0, 0)

    def attr(self, node, key, default=None):
        error, value = self.A.AXUIElementCopyAttributeValue(node, key, None)
        return value if error == 0 and value is not None else default

    def value_pair(self, value, kind):
        if value is None:
            return None
        ok, result = self.A.AXValueGetValue(value, kind, None)
        return result if ok else None

    def bounds(self, node):
        p = self.value_pair(self.attr(node, "AXPosition"), self.A.kAXValueTypeCGPoint)
        s = self.value_pair(self.attr(node, "AXSize"), self.A.kAXValueTypeCGSize)
        return dict(x=float(p[0]), y=float(p[1]), width=float(s[0]), height=float(s[1])) if p and s else dict(x=0, y=0, width=0, height=0)

    def app(self, pid):
        return self.A.AXUIElementCreateApplication(pid)

    def ax_window(self, w):
        frame = w["frame"]
        matches = []
        for node in self.attr(self.app(w["pid"]), "AXWindows", []):
            b = self.bounds(node)
            if all(abs(b[k] - frame[k]) <= 2 for k in b):
                matches.append(node)
        if len(matches) > 1:
            matches = [n for n in matches if self.attr(n, "AXTitle", "") == w["title"]]
        if len(matches) != 1:
            raise RuntimeError("Cannot uniquely match the selected window to its Accessibility window")
        return matches[0]

    def window_state(self, handle):
        return self.windows(handle)

    def windows(self, handle=None):
        rows = self.Q.CGWindowListCopyWindowInfo(self.Q.kCGWindowListOptionOnScreenOnly | self.Q.kCGWindowListExcludeDesktopElements, self.Q.kCGNullWindowID) or []
        out = []
        for item in rows:
            if handle is not None and int(item["kCGWindowNumber"]) != handle:
                continue
            if int(item.get("kCGWindowLayer", -1)) != 0 or float(item.get("kCGWindowAlpha", 0)) <= 0:
                continue
            pid = int(item["kCGWindowOwnerPID"])
            app = self.K.NSRunningApplication.runningApplicationWithProcessIdentifier_(pid)
            if not app or not app.executableURL():
                continue
            r = item["kCGWindowBounds"]
            if r["Width"] <= 1 or r["Height"] <= 1:
                continue
            w = dict(handle=int(item["kCGWindowNumber"]), pid=pid, title=str(item.get("kCGWindowName") or app.localizedName() or "Untitled"),
                     executable=str(app.executableURL().path()), frame=dict(x=float(r["X"]), y=float(r["Y"]), width=float(r["Width"]), height=float(r["Height"]), scale=1))
            try:
                w["title"] = str(self.attr(self.ax_window(w), "AXTitle", w["title"]))
            except RuntimeError:
                pass
            out.append(w)
        return out

    def focused(self, w):
        app = self.K.NSWorkspace.sharedWorkspace().frontmostApplication()
        if not app or app.processIdentifier() != w["pid"]:
            return False
        focused = self.attr(self.app(w["pid"]), "AXFocusedWindow")
        return bool(focused and self.F.CFEqual(focused, self.ax_window(w))) if hasattr(self.F, "CFEqual") else bool(focused and self.bounds(focused) == self.bounds(self.ax_window(w)))

    def focus(self, w):
        app = self.K.NSRunningApplication.runningApplicationWithProcessIdentifier_(w["pid"])
        if not app:
            raise RuntimeError("The selected app closed")
        node = self.ax_window(w)
        self.A.AXUIElementPerformAction(node, "AXRaise")
        app.activateWithOptions_(self.K.NSApplicationActivateIgnoringOtherApps)
        self.A.AXUIElementSetAttributeValue(node, "AXMain", True)
        for _ in range(15):
            if self.focused(w):
                break
            time.sleep(.05)

    def controls(self, w):
        self.refs = {}
        root = self.ax_window(w)
        out = []
        queue = [(root, "0")]
        seen = set()
        while queue and len(out) < 500:
            node, path = queue.pop(0)
            # AX trees sometimes expose the same node through multiple parents.
            ident_obj = hash(node)
            if ident_obj in seen:
                continue
            seen.add(ident_obj)
            role = str(self.attr(node, "AXRole", ""))
            subrole = str(self.attr(node, "AXSubrole", ""))
            if subrole == "AXSecureTextField":
                continue
            b = self.bounds(node)
            value = self.attr(node, "AXValue", "")
            value = str(value)[:8192] if isinstance(value, (str, int, float)) else ""
            name = str(self.attr(node, "AXTitle") or self.attr(node, "AXDescription") or self.attr(node, "AXHelp") or "")
            error, names = self.A.AXUIElementCopyActionNames(node, None)
            names = names or [] if error == 0 else []
            error, writable = self.A.AXUIElementIsAttributeSettable(node, "AXValue", None)
            editable = error == 0 and writable and role in ("AXTextField", "AXTextArea", "AXComboBox")
            enabled = bool(self.attr(node, "AXEnabled", True))
            actions = ["click"] if enabled and b["width"] > 0 and b["height"] > 0 else []
            if enabled and "AXPress" in names:
                actions.append("invoke")
            if enabled and editable:
                actions.append("fill")
            ident = f"ax:{w['pid']}:{w['handle']}:{path}"
            c = dict(index=len(out), id=ident, name=name, value=value, controlType=50004 if editable else 50000 if role in ("AXButton", "AXCheckBox", "AXMenuItem", "AXRadioButton") else 50020 if role == "AXStaticText" else 50033,
                     focused=bool(self.attr(node, "AXFocused", False)), offscreen=b["width"] <= 0 or b["height"] <= 0 or bool(self.attr(node, "AXHidden", False)), actions=actions, bounds=b)
            selected = self.value_pair(self.attr(node, "AXSelectedTextRange"), self.A.kAXValueTypeCFRange)
            if selected:
                c["selection"] = str(tuple(selected))
            out.append(c)
            self.refs[ident] = node
            queue.extend((child, f"{path}.{i}") for i, child in enumerate(self.attr(node, "AXChildren", [])[:500]))
        return out

    def async_result(self, operation):
        event = threading.Event()
        result = []
        def completed(value, error):
            result.extend([value, error]); event.set()
        operation(completed)
        until = time.monotonic() + 8
        while not event.is_set() and time.monotonic() < until:
            self.F.NSRunLoop.currentRunLoop().runUntilDate_(self.F.NSDate.dateWithTimeIntervalSinceNow_(.02))
        if not event.is_set():
            raise RuntimeError("ScreenCaptureKit request timed out")
        if result[1] is not None or result[0] is None:
            raise RuntimeError("ScreenCaptureKit failed: " + str(result[1]))
        return result[0]

    def capture(self, w):
        if not self.Q.CGPreflightScreenCaptureAccess():
            self.screenshot_status = "Screen Recording permission is not granted; accessibility controls only"
            return None
        content = self.async_result(lambda cb: self.S.SCShareableContent.getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler_(True, True, cb))
        windows = [window for window in content.windows() if window.windowID() == w["handle"] and window.owningApplication().processID() == w["pid"]]
        if len(windows) != 1:
            raise RuntimeError("Selected window is not available to ScreenCaptureKit")
        filter_ = self.S.SCContentFilter.alloc().initWithDesktopIndependentWindow_(windows[0])
        config = self.S.SCStreamConfiguration.alloc().init()
        # Output in desktop points so model coordinates and AX bounds share units.
        config.setWidth_(round(w["frame"]["width"]))
        config.setHeight_(round(w["frame"]["height"]))
        config.setShowsCursor_(False)
        if hasattr(config, "setIgnoreShadowsSingleWindow_"):
            config.setIgnoreShadowsSingleWindow_(True)
        image = self.async_result(lambda cb: self.S.SCScreenshotManager.captureImageWithFilter_configuration_completionHandler_(filter_, config, cb))
        rep = self.K.NSBitmapImageRep.alloc().initWithCGImage_(image)
        data = rep.representationUsingType_properties_(self.K.NSBitmapImageFileTypePNG, {})
        if data is None:
            raise RuntimeError("PNG encoding failed")
        self.screenshot_status = "ScreenCaptureKit"
        return bytes(data)

    def post_key(self, code, down, flags=0, text=None):
        if down:
            self.held_keys.add(code)
        e = self.Q.CGEventCreateKeyboardEvent(None, code, down)
        if e is None:
            raise RuntimeError("Quartz keyboard event creation failed")
        self.Q.CGEventSetFlags(e, flags)
        if text is not None:
            self.Q.CGEventKeyboardSetUnicodeString(e, len(text.encode("utf-16-le")) // 2, text)
        self.Q.CGEventPost(self.Q.kCGHIDEventTap, e)
        if not down: self.held_keys.discard(code)

    def mouse(self, kind, point):
        self.last_point = point
        if kind == self.Q.kCGEventLeftMouseDown:
            self.held_mouse = True
        event = self.Q.CGEventCreateMouseEvent(None, kind, point, self.Q.kCGMouseButtonLeft)
        if event is None: raise RuntimeError("Quartz mouse event creation failed")
        self.Q.CGEventPost(self.Q.kCGHIDEventTap, event)
        if kind == self.Q.kCGEventLeftMouseUp: self.held_mouse = False

    def execute(self, w, op, args, guard):
        guard()
        if op in ("invoke", "fill"):
            node = self.refs[args["locator"]]
            error = self.A.AXUIElementPerformAction(node, "AXPress") if op == "invoke" else self.A.AXUIElementSetAttributeValue(node, "AXValue", args["value"])
            if error:
                raise RuntimeError(f"Accessibility action failed with AXError {error}")
        elif op == "type":
            # Unicode event text is literal and independent of the active key layout.
            for char in args["text"]:
                guard(); self.post_key(0, True, text=char); self.post_key(0, False, text=char)
                time.sleep(.01)
        elif op == "key":
            codes = {"A": 0, "S": 1, "F": 3, "Z": 6, "C": 8, "V": 9, "O": 31, "N": 45, "L": 37, "Enter": 36, "Tab": 48, "Space": 49, "Backspace": 51, "Escape": 53, "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121, "Delete": 117, "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126, "F12": 111}
            modifiers = {"Control": (59, self.Q.kCGEventFlagMaskControl), "Shift": (56, self.Q.kCGEventFlagMaskShift), "Meta": (55, self.Q.kCGEventFlagMaskCommand)}
            parts = args["key"].split("+")
            flags = 0
            for part in parts[:-1]:
                flags |= modifiers[part][1]
                guard(); self.post_key(modifiers[part][0], True, flags)
            code = codes[parts[-1]]
            guard(); self.post_key(code, True, flags); self.post_key(code, False, flags)
            for part in reversed(parts[:-1]):
                flags &= ~modifiers[part][1]
                self.post_key(modifiers[part][0], False, flags)
        elif op in ("click", "drag"):
            f = w["frame"]
            start = (f["x"] + args["x"], f["y"] + args["y"])
            self.mouse(self.Q.kCGEventMouseMoved, start)
            guard(); self.mouse(self.Q.kCGEventLeftMouseDown, start)
            if op == "drag":
                for i in range(1, 13):
                    guard()
                    self.mouse(self.Q.kCGEventLeftMouseDragged, (start[0] + (args["dx"] - args["x"]) * i / 12, start[1] + (args["dy"] - args["y"]) * i / 12))
                    time.sleep(.02)
            self.mouse(self.Q.kCGEventLeftMouseUp, self.last_point)
        elif op == "scroll":
            f = w["frame"]
            self.mouse(self.Q.kCGEventMouseMoved, (f["x"] + f["width"] / 2, f["y"] + f["height"] / 2))
            guard()
            e = self.Q.CGEventCreateScrollWheelEvent(None, self.Q.kCGScrollEventUnitLine, 1, int(math.copysign(max(1, abs(args["amount"]) // 120), args["amount"])))
            self.Q.CGEventPost(self.Q.kCGHIDEventTap, e)

    def cleanup(self):
        for code in list(self.held_keys):
            self.post_key(code, False)
        if self.held_mouse:
            self.mouse(self.Q.kCGEventLeftMouseUp, self.last_point)

    def close(self):
        self.cleanup()
