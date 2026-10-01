"""Linux AT-SPI2 accessibility, X11 input or consent-bound Wayland portals.

Wayland global input and capture require explicit portal consent. The adapter
never silently controls XWayland instead of the user's Wayland session.
"""
import io
import hashlib
import math
import os
import time
from pathlib import Path
from common import COMMON_KEYS, CONTROL_KEYS


class LinuxDesktop:
    platform = "Linux"
    def __init__(self):
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        self.A = Atspi
        Atspi.init()
        Atspi.set_timeout(1000, 2000)
        self.root = Atspi.get_desktop(0)
        if self.root is None:
            raise RuntimeError("AT-SPI accessibility bus is unavailable. Start inside your logged-in desktop session")
        self.wayland = os.environ.get("XDG_SESSION_TYPE") == "wayland" or bool(os.environ.get("WAYLAND_DISPLAY"))
        self.x = None
        if not self.wayland:
            from Xlib import display, X, XK
            from Xlib.ext import xtest
            self.X, self.XK, self.xtest = X, XK, xtest
            self.x = display.Display()
            if not self.x.has_extension("XTEST"):
                raise RuntimeError("The X server does not support XTEST input")
        self.name = "linux-atspi-wayland" if self.wayland else "linux-atspi-x11"
        self.session = f"linux-{os.getuid()}-{os.environ.get('XDG_SESSION_ID') or os.environ.get('WAYLAND_DISPLAY') or os.environ.get('DISPLAY')}"
        self.operations = ["invoke", "fill", "type"] + ([] if self.wayland else ["click", "key", "scroll", "drag"])
        self.keys = [] if self.wayland else COMMON_KEYS + CONTROL_KEYS
        self.screenshot_status = "unavailable on Wayland; accessibility controls only" if self.wayland else "X11 window crop"
        self.notes = ("Wayland supports accessible controls and editable text. Global input and capture require explicit XDG RemoteDesktop portal consent. No portal consent is bypassed." if self.wayland else "X11 session with AT-SPI2. Apps must expose accessibility controls for semantic actions.")
        self.portal = None
        self.on_portal_revoked = lambda _reason: None
        if self.wayland:
            from portal import DesktopPortal
            self.portal = DesktopPortal(self.portal_revoked)
        self.refs = {}
        self.window_refs = {}
        self.held_keys = set()
        self.held_buttons = set()

    def portal_revoked(self, reason):
        self.operations = ["invoke", "fill", "type"]
        self.keys = []
        self.screenshot_status = "Portal revoked: " + reason
        self.on_portal_revoked(reason)

    def poll(self):
        if self.portal: self.portal.pump()

    def close_portal(self):
        if self.portal: self.portal.close()

    def request_consent(self, timeout_ms=60000, cancelled=lambda: False):
        if not self.portal: raise RuntimeError("Portal consent is only needed on Wayland")
        result = self.portal.request_consent(timeout_ms, cancelled)
        self.operations = ["invoke", "fill", "type"]
        if self.portal.devices & 2: self.operations += ["click", "drag", "scroll", "hold"]
        if self.portal.devices & 1:
            self.operations += ["key"]
            if "hold" not in self.operations: self.operations.append("hold")
            self.keys = COMMON_KEYS + CONTROL_KEYS
        self.screenshot_status = "Consent-bound PipeWire stream; verified window mapping required"
        self.notes = "Explicit portal consent. Selected monitor only; stream/window mapping must verify. No XWayland input. Current verified pointer profile requires scale 1."
        return result

    def children(self, node, limit=500):
        return [node.get_child_at_index(i) for i in range(min(node.get_child_count(), limit))]

    def bounds(self, node):
        c = node.get_component_iface()
        if not c:
            return dict(x=0, y=0, width=0, height=0)
        r = c.get_extents(self.A.CoordType.SCREEN)
        return dict(x=r.x, y=r.y, width=r.width, height=r.height)

    def prop(self, window, name):
        p = window.get_full_property(self.x.intern_atom(name), self.X.AnyPropertyType)
        return p.value if p else None

    def xwindows(self):
        root = self.x.screen().root
        ids = self.prop(root, "_NET_CLIENT_LIST")
        result = []
        if ids is None:
            ids = [w.id for w in root.query_tree().children]
        for handle in ids:
            try:
                w = self.x.create_resource_object("window", int(handle))
                pid = self.prop(w, "_NET_WM_PID")
                if pid is None:
                    continue
                title = self.prop(w, "_NET_WM_NAME")
                title = bytes(title).decode("utf-8", "replace") if title is not None else w.get_wm_name()
                if not title:
                    continue
                g = w.get_geometry()
                p = root.translate_coords(w, 0, 0)
                # translate_coords maps source coordinates into the receiving window.
                frame = dict(x=p.x, y=p.y, width=g.width, height=g.height, scale=1)
                path = os.readlink(f"/proc/{int(pid[0])}/exe")
                result.append(dict(handle=int(handle), pid=int(pid[0]), title=str(title), executable=path, frame=frame))
            except Exception:
                continue
        return result

    def accessible_windows(self):
        result = []
        for app in self.children(self.root):
            try:
                pid = app.get_process_id()
                for node in self.children(app):
                    if node.get_role() not in (self.A.Role.FRAME, self.A.Role.DIALOG, self.A.Role.WINDOW):
                        continue
                    result.append((pid, node))
            except Exception:
                continue
        return result

    def windows(self):
        accessible = self.accessible_windows()
        if self.x:
            windows = self.xwindows()
            self.window_refs = {}
            for w in windows:
                candidates = [n for pid, n in accessible if pid == w["pid"] and n.get_name() == w["title"]]
                if len(candidates) != 1:
                    candidates = [n for pid, n in accessible if pid == w["pid"] and self.bounds(n) == {k: v for k, v in w["frame"].items() if k != "scale"}]
                if len(candidates) == 1:
                    self.window_refs[w["handle"]] = candidates[0]
            return windows
        windows = []
        self.window_refs = {}
        for pid, node in accessible:
            try:
                if not node.get_state_set().contains(self.A.StateType.SHOWING):
                    continue
                # Stable across worker restarts and title changes, but not a
                # recycled PID. Keep the numeric ID within JavaScript's safe range.
                start = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
                identity = f"{pid}:{start}:{node.path}"
                handle = int(hashlib.sha256(identity.encode()).hexdigest()[:13], 16)
                b = self.bounds(node)
                if b["width"] <= 0 or b["height"] <= 0:
                    continue
                windows.append(dict(handle=handle, pid=pid, title=node.get_name() or "Untitled", executable=os.readlink(f"/proc/{pid}/exe"), frame={**b, "scale": 1}))
                self.window_refs[handle] = node
            except Exception:
                continue
        return windows

    def focused(self, w):
        self.poll()
        if self.x:
            current = self.x.get_input_focus().focus
            for _ in range(20):
                if not hasattr(current, "id"):
                    return False
                if current.id == w["handle"]:
                    return True
                parent = current.query_tree().parent
                if not hasattr(parent, "id") or parent.id == current.id:
                    break
                current = parent
            return False
        node = self.window_refs.get(w["handle"])
        if node: node.clear_cache()
        return bool(node and node.get_state_set().contains(self.A.StateType.ACTIVE))

    def focus(self, w):
        if self.x:
            from Xlib.protocol import event
            win = self.x.create_resource_object("window", w["handle"])
            root = self.x.screen().root
            root.send_event(event.ClientMessage(window=win, client_type=self.x.intern_atom("_NET_ACTIVE_WINDOW"), data=(32, [2, self.X.CurrentTime, 0, 0, 0])), event_mask=self.X.SubstructureRedirectMask | self.X.SubstructureNotifyMask)
            self.x.flush()
        else:
            node = self.window_refs.get(w["handle"])
            if node and node.get_component_iface():
                node.get_component_iface().grab_focus()
        for _ in range(10):
            if self.focused(w):
                break
            time.sleep(.05)

    def controls(self, w):
        self.refs = {}
        root = self.window_refs.get(w["handle"])
        if not root:
            return []
        out = []
        queue = [(root, "0")]
        while queue and len(out) < 500:
            node, path = queue.pop(0)
            try:
                node.clear_cache()
                role = node.get_role()
                if role == self.A.Role.PASSWORD_TEXT:
                    continue
                state = node.get_state_set()
                if state.contains(self.A.StateType.DEFUNCT):
                    continue
                b = self.bounds(node)
                text = node.get_text_iface()
                editable = node.get_editable_text_iface() if state.contains(self.A.StateType.EDITABLE) else None
                value = text.get_text(0, min(text.get_character_count(), 8192)) if text else ""
                ctype = 50004 if editable else 50000 if role in (self.A.Role.PUSH_BUTTON, self.A.Role.TOGGLE_BUTTON, self.A.Role.CHECK_BOX, self.A.Role.MENU_ITEM) else 50020 if text else 50033
                actions = [] if "click" not in self.operations or b["width"] <= 0 or b["height"] <= 0 else ["click"]
                action = node.get_action_iface()
                # Only ordinary activation actions are exposed, never arbitrary API names.
                action_index = next((i for i in range(action.get_n_actions()) if action.get_action_name(i).lower() in ("click", "press", "activate", "toggle")), None) if action else None
                if action_index is not None:
                    actions.append("invoke")
                if editable:
                    actions.append("fill")
                ident = f"atspi:{w['pid']}:{w['handle']}:{path}"
                c = dict(index=len(out), id=ident, name=node.get_name() or "", value=value or "", controlType=ctype,
                         focused=state.contains(self.A.StateType.FOCUSED), offscreen=not state.contains(self.A.StateType.SHOWING), actions=actions, bounds=b)
                if text:
                    selections = [text.get_selection(i) for i in range(min(text.get_n_selections(), 4))]
                    c["selection"] = str(text.get_caret_offset()) + ":" + repr([(item.start_offset, item.end_offset) for item in selections])
                out.append(c)
                self.refs[ident] = (node, action_index)
                queue.extend((child, f"{path}.{i}") for i, child in enumerate(self.children(node)))
            except Exception:
                continue
        return out

    def portal_frame(self, w):
        _node, properties = self.portal.stream_for(w["frame"])
        f = w["frame"]
        if tuple(properties["position"]) != (f["x"], f["y"]) or tuple(properties["size"]) != (f["width"], f["height"]):
            raise RuntimeError("Wayland window origin is unverified. Portal pointer and capture currently require a focused fullscreen window on the selected monitor")
        if tuple(properties["size"]) != self.portal.pixel_size or f.get("scale") != 1:
            raise RuntimeError("Wayland portal coordinates require the verified scale-1 profile")

    def capture(self, w):
        self.capture_facts = {}
        if not self.x:
            self.poll()
            if self.portal and self.portal.active:
                if not self.focused(w):
                    self.screenshot_status = "Window must be focused for a portal crop"
                    return None
                try:
                    self.portal_frame(w)
                    png = self.portal.capture(w["frame"], getattr(self, "capture_after", None))
                except RuntimeError as error:
                    self.screenshot_status = str(error)
                    return None
                self.capture_facts = dict(self.portal.capture_facts)
                self.screenshot_status = ("Last-delivered authorized PipeWire frame; current pixels unverified" if self.capture_facts.get("pixelFrameCached") else "New source-timestamped PipeWire delivery of selected fullscreen window")
                return png
            return None
        from PIL import Image
        f = w["frame"]
        if not self.focused(w):
            self.screenshot_status = "Window must be focused for a desktop crop"
            return None
        root = self.x.screen().root
        g = root.get_geometry()
        x, y, width, height = (int(f[k]) for k in ("x", "y", "width", "height"))
        if x < 0 or y < 0 or x + width > g.width or y + height > g.height:
            self.screenshot_status = "Window extends outside the visible display; accessibility controls remain available"
            return None
        image = root.get_image(x, y, width, height, self.X.ZPixmap, 0xffffffff)
        format_ = next(p for p in self.x.display.info.pixmap_formats if p.depth == image.depth)
        if format_.bits_per_pixel != 32 or self.x.display.info.image_byte_order != self.X.LSBFirst:
            raise RuntimeError("X11 capture requires a 24/32-bit little-endian visual")
        png = io.BytesIO()
        Image.frombytes("RGB", (width, height), image.data, "raw", "BGRX").save(png, "PNG")
        self.screenshot_status = "X11 window crop"
        return png.getvalue()

    def key_event(self, keycode, down):
        if down:
            self.held_keys.add(keycode)
        self.xtest.fake_input(self.x, self.X.KeyPress if down else self.X.KeyRelease, keycode)
        self.x.sync()
        if not down: self.held_keys.discard(keycode)

    def mouse_event(self, button, down):
        if down:
            self.held_buttons.add(button)
        self.xtest.fake_input(self.x, self.X.ButtonPress if down else self.X.ButtonRelease, button)
        self.x.sync()
        if not down: self.held_buttons.discard(button)

    def execute(self, w, op, args, guard):
        guard()
        if self.wayland and op in ("click", "drag", "key", "scroll", "hold"):
            if w["frame"].get("scale") != 1: raise RuntimeError("Portal pointer mapping requires a verified scale-1 profile")
            self.portal.require()
            if op in ("click", "scroll", "drag") or op == "hold" and "button" in args:
                self.portal_frame(w)
            if op == "key" or op == "hold" and "key" in args:
                keysyms = {"Control": 0xffe3, "Shift": 0xffe1, "Enter": 0xff0d, "Tab": 0xff09, "Escape": 0xff1b, "Space": 0x20, "ArrowLeft": 0xff51, "ArrowUp": 0xff52, "ArrowRight": 0xff53, "ArrowDown": 0xff54, "Home": 0xff50, "End": 0xff57, "PageUp": 0xff55, "PageDown": 0xff56, "Backspace": 0xff08, "Delete": 0xffff, "F12": 0xffc9}
                codes = [keysyms.get(part, ord(part.lower()) if len(part) == 1 else None) for part in args["key"].split("+")]
                if any(code is None for code in codes): raise RuntimeError("Portal shortcut keysym is unsupported")
                for code in codes: guard(); self.portal.key(code, True)
                if op == "hold":
                    end = time.monotonic() + args["durationMs"] / 1000
                    while time.monotonic() < end: guard(); time.sleep(.01)
                for code in reversed(codes): self.portal.key(code, False)
            elif op in ("click", "drag", "hold"):
                frame = w["frame"]
                self.portal.move(frame, args.get("x", frame["width"] / 2), args.get("y", frame["height"] / 2))
                guard(); self.portal.button(0x110, True)
                if op == "drag":
                    for i in range(1, 13):
                        guard(); self.portal.move(frame, args["x"] + (args["dx"] - args["x"]) * i / 12, args["y"] + (args["dy"] - args["y"]) * i / 12); time.sleep(.02)
                elif op == "hold":
                    end = time.monotonic() + args["durationMs"] / 1000
                    while time.monotonic() < end: guard(); time.sleep(.01)
                self.portal.button(0x110, False)
            elif op == "scroll": self.portal.scroll(args["amount"])
            return
        if op in ("invoke", "fill"):
            node, index = self.refs[args["locator"]]
            ok = node.get_action_iface().do_action(index) if op == "invoke" else node.get_editable_text_iface().set_text_contents(args["value"])
            if not ok:
                raise RuntimeError("The app rejected the accessibility action")
        elif op == "type":
            matches = [(n, n.get_text_iface()) for n, _ in self.refs.values() if n.get_state_set().contains(self.A.StateType.FOCUSED) and n.get_editable_text_iface()]
            if len(matches) != 1:
                raise RuntimeError("No unique focused editable text target")
            node, text = matches[0]
            count = text.get_character_count()
            if count > 8192:
                raise RuntimeError("Use an editor selection or smaller document for this bounded text action")
            current = text.get_text(0, count)
            start = end = text.get_caret_offset()
            if text.get_n_selections():
                selection = text.get_selection(0)
                start, end = selection.start_offset, selection.end_offset
            if not node.get_editable_text_iface().set_text_contents(current[:start] + args["text"] + current[end:]):
                raise RuntimeError("The app rejected text insertion")
            text.set_caret_offset(start + len(args["text"]))
        elif op == "key":
            names = {"Control": "Control_L", "Shift": "Shift_L", "Enter": "Return", "Space": "space", "ArrowLeft": "Left", "ArrowRight": "Right", "ArrowUp": "Up", "ArrowDown": "Down", "PageUp": "Prior", "PageDown": "Next", "Backspace": "BackSpace"}
            codes = [self.x.keysym_to_keycode(self.XK.string_to_keysym(names.get(k, k.lower() if len(k) == 1 else k))) for k in args["key"].split("+")]
            if not all(codes):
                raise RuntimeError("Shortcut is absent from the current keyboard layout")
            for code in codes:
                guard(); self.key_event(code, True)
            for code in reversed(codes):
                self.key_event(code, False)
        elif op in ("click", "drag"):
            f = w["frame"]
            self.xtest.fake_input(self.x, self.X.MotionNotify, x=round(f["x"] + args["x"]), y=round(f["y"] + args["y"]))
            self.x.sync(); guard(); self.mouse_event(1, True)
            if op == "drag":
                for i in range(1, 13):
                    guard()
                    self.xtest.fake_input(self.x, self.X.MotionNotify, x=round(f["x"] + args["x"] + (args["dx"] - args["x"]) * i / 12), y=round(f["y"] + args["y"] + (args["dy"] - args["y"]) * i / 12))
                    self.x.sync(); time.sleep(.02)
            self.mouse_event(1, False)
        elif op == "scroll":
            f = w["frame"]
            self.xtest.fake_input(self.x, self.X.MotionNotify, x=round(f["x"] + f["width"] / 2), y=round(f["y"] + f["height"] / 2))
            for _ in range(max(1, math.ceil(abs(args["amount"]) / 120))):
                guard(); self.mouse_event(4 if args["amount"] > 0 else 5, True); self.mouse_event(4 if args["amount"] > 0 else 5, False)

    def cleanup(self):
        if self.portal: self.portal.cleanup()
        if self.x:
            for code in list(self.held_keys):
                self.key_event(code, False)
            for button in list(self.held_buttons):
                self.mouse_event(button, False)

    def close(self):
        self.cleanup()
        if self.portal: self.portal.close()
        if self.x:
            self.x.close()
