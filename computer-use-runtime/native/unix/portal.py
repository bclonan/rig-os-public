"""Consent-bound XDG RemoteDesktop and ScreenCast session. No XWayland fallback.

Gio and GStreamer are imported only when the user requests consent. The portal
transport is injectable for protocol tests, which are not native execution proof.
"""
import io
import os
import time
import uuid
from capture_worker import PipeWireCapture


def _cleanup_cause(message, errors):
    # RuntimeError works on Python 3.10 too. Keep every original exception so
    # callers can inspect the failures after all independent cleanup attempts.
    cause = RuntimeError(message + ": " + "; ".join(str(error) for error in errors))
    cause.exceptions = tuple(errors)
    return cause


class GioPortalTransport:
    NAME = "org.freedesktop.portal.Desktop"
    PATH = "/org/freedesktop/portal/desktop"

    def __init__(self):
        import gi
        from gi.repository import Gio, GLib
        self.Gio, self.GLib = Gio, GLib
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.context = GLib.MainContext.default()
        self.subscriptions = []

    def options(self, values):
        signatures = {"handle_token": "s", "session_handle_token": "s", "types": "u", "multiple": "b", "cursor_mode": "u", "persist_mode": "u", "finish": "b"}
        return {key: self.GLib.Variant(signatures[key], value) for key, value in values.items()}

    def pump(self):
        while self.context.pending():
            self.context.iteration(False)

    def call(self, interface, method, signature, arguments, timeout_ms=5000, path=None):
        reply = self.bus.call_sync(self.NAME, path or self.PATH, "org.freedesktop.portal." + interface,
                                   method, self.GLib.Variant(signature, arguments), None,
                                   self.Gio.DBusCallFlags.NONE, timeout_ms, None)
        return reply.unpack()

    def request(self, interface, method, signature, arguments, deadline, cancelled=lambda: False):
        token = "cur_" + uuid.uuid4().hex
        sender = self.bus.get_unique_name().lstrip(":").replace(".", "_")
        expected = self.PATH + "/request/" + sender + "/" + token
        response = {}
        returned = None
        args = list(arguments)
        opts = dict(args[-1]); opts["handle_token"] = token; args[-1] = self.options(opts)
        def received(_bus, _sender, path, _interface, _signal, parameters, _user):
            if path == expected or returned and path == returned:
                response["value"] = parameters.unpack()
        # Listen before the call. A fast portal can emit Response before return.
        subscription = self.bus.signal_subscribe(self.NAME, "org.freedesktop.portal.Request", "Response", None, None,
                                                 self.Gio.DBusSignalFlags.NONE, received, None)
        try:
            returned = self.call(interface, method, signature, tuple(args), min(5000, max(1, int((deadline-time.monotonic())*1000))))[0]
            if returned != expected:
                try: self.call("Request", "Close", "()", (), path=returned)
                except Exception: pass
                raise RuntimeError("Portal returned an unexpected request handle")
            while "value" not in response:
                self.pump()
                if cancelled() or time.monotonic() >= deadline:
                    try: self.call("Request", "Close", "()", (), path=returned)
                    except Exception: pass
                    # Request.Close does not emit Response. Settle locally now.
                    raise RuntimeError("Portal consent cancelled or timed out")
                time.sleep(.01)
            code, values = response["value"]
            if code != 0:
                raise RuntimeError("Portal permission denied or cancelled" if code == 1 else "Portal request failed")
            return values
        finally:
            self.bus.signal_unsubscribe(subscription)

    def watch(self, session, revoke):
        closed = self.bus.signal_subscribe(self.NAME, "org.freedesktop.portal.Session", "Closed", session, None,
                                           self.Gio.DBusSignalFlags.NONE, lambda *_args: revoke("Portal Session.Closed signal", session_closed=True), None)
        def owner_changed(_bus, _sender, _path, _interface, _signal, parameters, _user):
            name, old, new = parameters.unpack()
            compositor = name in ("org.gnome.Mutter.RemoteDesktop", "org.gnome.Mutter.ScreenCast")
            if old and old != new and (name == self.NAME or name.startswith("org.freedesktop.impl.portal.desktop.") or compositor):
                revoke("Portal D-Bus owner changed: " + name)
        # Older frontends can retain sessions after their backend disappears.
        # Conservatively revoke on any desktop portal backend owner loss too.
        owner = self.bus.signal_subscribe("org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged", "/org/freedesktop/DBus", None,
                                          self.Gio.DBusSignalFlags.NONE, owner_changed, None)
        self.subscriptions.extend([closed, owner])

    def pipewire_remote(self, session, timeout_ms=5000):
        reply, descriptors = self.bus.call_with_unix_fd_list_sync(self.NAME, self.PATH, "org.freedesktop.portal.ScreenCast", "OpenPipeWireRemote",
            self.GLib.Variant("(oa{sv})", (session, {})), None, self.Gio.DBusCallFlags.NONE, timeout_ms, None, None)
        return descriptors.get(reply.unpack()[0])

    def notify(self, method, signature, arguments):
        return self.call("RemoteDesktop", method, signature, arguments)

    def close(self):
        for subscription in self.subscriptions: self.bus.signal_unsubscribe(subscription)
        self.subscriptions.clear()


class _PipeWirePipeline:
    def __init__(self, fd, node):
        import gi
        gi.require_version("Gst", "1.0")
        gi.require_version("GstVideo", "1.0")
        from gi.repository import Gst, GstVideo
        Gst.init(None)
        self.Gst, self.Video = Gst, GstVideo
        if not Gst.ElementFactory.find("pipewiresrc"):
            raise RuntimeError("Install gstreamer1.0-pipewire for portal screenshots")
        # Do not enable keepalive/resend-last: those reissue old pixels with a
        # new PTS. Preserve the source timestamp for every delivered buffer.
        self.pipeline = Gst.parse_launch(f"pipewiresrc fd={int(fd)} path={int(node)} do-timestamp=false keepalive-time=0 resend-last=false ! videoconvert ! video/x-raw,format=RGB ! appsink name=frame max-buffers=1 drop=true sync=false")
        self.sink = self.pipeline.get_by_name("frame")
        self.last_image = None; self.metadata = {}; self.sequence = 0; self.closed = False
        self.pipeline.set_state(Gst.State.PLAYING)

    def image(self, timeout_ms=250, after=None):
        deadline = time.monotonic() + timeout_ms / 1000
        while True:
            image = self.read_image(max(0, int((deadline-time.monotonic())*1000)))
            if after is None or self.metadata.get("pixelCapturedAt", 0) >= after or self.metadata.get("pixelFrameCached") or time.monotonic() >= deadline:
                return image

    def read_image(self, timeout_ms):
        from PIL import Image
        self.poll()
        sample = self.sink.emit("try-pull-sample", int(timeout_ms * self.Gst.MSECOND))
        if sample is None:
            self.poll()
            if self.last_image is None: raise RuntimeError("PipeWire first frame timed out")
            # Silence is not proof of current pixels. This is display evidence
            # only; global-input preflight refuses it in common.Bridge.
            self.metadata = {**self.metadata, "pixelFrameCached": True}
            return self.last_image.copy()
        # Read the latest queued delivery, with a bound even on a busy producer.
        drain_deadline = time.monotonic() + .025
        for _ in range(32):
            if time.monotonic() >= drain_deadline: break
            newer = self.sink.emit("try-pull-sample", 0)
            if newer is None: break
            sample = newer
        info = self.Video.VideoInfo.new_from_caps(sample.get_caps())
        buffer = sample.get_buffer()
        if buffer.has_flags(self.Gst.BufferFlags.CORRUPTED): raise RuntimeError("PipeWire frame is corrupted")
        ok, mapped = buffer.map(self.Gst.MapFlags.READ)
        if not ok: raise RuntimeError("PipeWire frame mapping failed")
        try:
            if not 0 < info.width <= 16384 or not 0 < info.height <= 16384: raise RuntimeError("PipeWire frame size rejected")
            image = Image.frombytes("RGB", (info.width, info.height), bytes(mapped.data), "raw", "RGB", info.stride[0]).copy()
        finally: buffer.unmap(mapped)
        self.poll()
        received_at = int(time.time()*1000)
        self.sequence += 1
        self.metadata = {"pixelFrameCached": False, "pixelFrameSequence": self.sequence,
                         "pixelReceivedAt": received_at, "pixelTimestampProvenance": "GStreamer source PTS mapped through pipeline clock"}
        clock = self.pipeline.get_clock()
        if clock and buffer.pts != self.Gst.CLOCK_TIME_NONE:
            age_ns = int(clock.get_time()) - int(self.pipeline.get_base_time()) - int(buffer.pts)
            self.metadata["pixelSourcePtsNs"] = str(buffer.pts)
            if age_ns >= 0: self.metadata["pixelCapturedAt"] = received_at - int(age_ns / 1_000_000)
        self.last_image = image
        return image.copy()

    def close(self):
        self.closed = True; self.last_image = None; self.metadata = {}
        self.pipeline.set_state(self.Gst.State.NULL)

    def poll(self):
        if self.closed: raise RuntimeError("PipeWire capture is closed")
        message = self.pipeline.get_bus().pop_filtered(self.Gst.MessageType.ERROR | self.Gst.MessageType.EOS)
        if message:
            detail = str(message.parse_error()[0]) if message.type == self.Gst.MessageType.ERROR else "stream ended"
            raise RuntimeError("PipeWire capture unavailable: " + detail)


class DesktopPortal:
    def __init__(self, revoked=lambda _reason: None, transport_factory=GioPortalTransport, capture_factory=PipeWireCapture):
        self.transport_factory, self.capture_factory = transport_factory, capture_factory
        self.transport = None; self.capture_pipe = None; self.fd = None
        self.session = None; self.devices = 0; self.streams = []; self.active = False; self.pending = False
        self.held_keys = set(); self.held_buttons = set(); self.revoked = revoked
        self.pixel_size = None
        self.capture_facts = {}; self.capture_generation = None
        self.unsettled_inputs = False
        self.cleanup_status = "No input is held"
        self.status = "Portal permission has not been requested"

    def request_consent(self, timeout_ms=60000, cancelled=lambda: False):
        if not isinstance(timeout_ms, int) or not 1000 <= timeout_ms <= 120000:
            raise RuntimeError("Portal consent timeout must be 1000 to 120000 ms")
        self.close(); self.pending = True
        deadline = time.monotonic() + timeout_ms / 1000
        try:
            self.transport = self.transport_factory()
            result = self.transport.request("RemoteDesktop", "CreateSession", "(a{sv})", ({"session_handle_token": "cur_" + uuid.uuid4().hex},), deadline, cancelled)
            self.session = result.get("session_handle")
            if not isinstance(self.session, str) or not self.session.startswith("/org/freedesktop/portal/desktop/session/"):
                raise RuntimeError("Portal session handle rejected")
            self.transport.watch(self.session, self.revoke)
            self.transport.request("RemoteDesktop", "SelectDevices", "(oa{sv})", (self.session, {"types": 3, "persist_mode": 0}), deadline, cancelled)
            self.transport.request("ScreenCast", "SelectSources", "(oa{sv})", (self.session, {"types": 1, "multiple": False, "cursor_mode": 1}), deadline, cancelled)
            result = self.transport.request("RemoteDesktop", "Start", "(osa{sv})", (self.session, "", {}), deadline, cancelled)
            self.devices = int(result.get("devices", 0)) & 3
            self.streams = result.get("streams", [])
            if not self.streams: raise RuntimeError("Portal granted no screen stream")
            if cancelled() or time.monotonic() >= deadline: raise RuntimeError("Portal consent cancelled or timed out")
            self.fd = self.transport.pipewire_remote(self.session, min(5000, max(1, int((deadline-time.monotonic())*1000))))
            if self.capture_factory is PipeWireCapture:
                self.capture_pipe = self.capture_factory(self.fd, self.streams[0][0],
                    max(1, int((deadline-time.monotonic())*1000)), cancelled)
            else:
                self.capture_pipe = self.capture_factory(self.fd, self.streams[0][0])
            self.capture_generation = uuid.uuid4().hex
            if cancelled() or time.monotonic() >= deadline: raise RuntimeError("Portal consent cancelled or timed out")
            timeout = min(2000, max(1, int((deadline-time.monotonic())*1000)))
            first = (self.capture_pipe.image(timeout, deadline=deadline, cancelled=cancelled)
                     if self.capture_factory is PipeWireCapture else self.capture_pipe.image(timeout))
            self.pixel_size = (first.width, first.height)
            self.active = True; self.status = "Explicit portal consent granted"
            return {"granted": True, "devices": self.devices, "streams": len(self.streams)}
        except Exception:
            self.close(); raise
        finally: self.pending = False

    def pump(self):
        if self.transport: self.transport.pump()
        if self.active and self.capture_pipe and hasattr(self.capture_pipe, "poll"):
            try: self.capture_pipe.poll()
            except RuntimeError as error:
                # Cleanup must not re-enter this failed capture through
                # key/button require()->pump(). Session.Close independently
                # settles held input when capture authority is withdrawn.
                self.active = False; self.devices = 0; self.streams = []
                self.pixel_size = None; self.capture_facts = {}; self.capture_generation = None
                self.close(); self.status = str(error)

    def require(self, device=0):
        self.pump()
        if not self.active or device and not self.devices & device:
            raise RuntimeError("Portal consent or required device is unavailable")

    def stream_for(self, frame):
        self.require()
        if len(self.streams) != 1: raise RuntimeError("Portal stream mapping is ambiguous")
        for node, properties in self.streams:
            position, size = properties.get("position"), properties.get("size")
            if properties.get("source_type") != 1 or not position or not size: continue
            x, y = position; width, height = size
            if width > 0 and height > 0 and frame["x"] >= x and frame["y"] >= y and frame["x"] + frame["width"] <= x + width and frame["y"] + frame["height"] <= y + height:
                return node, properties
        raise RuntimeError("Portal stream has no verified coordinate mapping for this window")

    def capture(self, frame, after=None):
        node, properties = self.stream_for(frame)
        if node != self.streams[0][0]: raise RuntimeError("Selected PipeWire node changed")
        try: image = self.capture_pipe.image() if after is None else self.capture_pipe.image(after=after)
        except RuntimeError as error:
            self.close(); self.status = "PipeWire capture unavailable: " + str(error); raise
        self.pixel_size = (image.width, image.height)
        self.require()
        self.capture_facts = {**getattr(self.capture_pipe, "metadata", {}), "pipewireSessionGeneration": self.capture_generation}
        x, y = properties["position"]; width, height = properties["size"]
        sx, sy = image.width / width, image.height / height
        box = (round((frame["x"]-x)*sx), round((frame["y"]-y)*sy), round((frame["x"]-x+frame["width"])*sx), round((frame["y"]-y+frame["height"])*sy))
        png = io.BytesIO(); image.crop(box).save(png, "PNG"); return png.getvalue()

    def move(self, frame, x, y):
        self.require(2)
        node, properties = self.stream_for(frame)
        if tuple(properties["size"]) != self.pixel_size:
            raise RuntimeError("Portal pointer scale profile is not verified; only scale 1 is supported")
        px, py = properties["position"]
        self.transport.notify("NotifyPointerMotionAbsolute", "(oa{sv}udd)", (self.session, {}, int(node), float(frame["x"] + x - px), float(frame["y"] + y - py)))

    def button(self, button, down):
        self.require(2)
        if down: self.held_buttons.add(button)
        self.transport.notify("NotifyPointerButton", "(oa{sv}iu)", (self.session, {}, button, 1 if down else 0))
        if not down: self.held_buttons.discard(button)

    def key(self, keysym, down):
        self.require(1)
        if down: self.held_keys.add(keysym)
        self.transport.notify("NotifyKeyboardKeysym", "(oa{sv}iu)", (self.session, {}, keysym, 1 if down else 0))
        if not down: self.held_keys.discard(keysym)

    def scroll(self, amount):
        self.require(2)
        self.transport.notify("NotifyPointerAxis", "(oa{sv}dd)", (self.session, self.transport.options({"finish": True}), 0., -float(amount)))

    def cleanup(self):
        errors = []
        if not self.active and (self.held_keys or self.held_buttons):
            try:
                self.transport.call("Session", "Close", "()", (), timeout_ms=1000, path=self.session)
            except Exception as error:
                self.unsettled_inputs = True
                raise RuntimeError("Portal input settlement is unconfirmed: " + str(error)) from error
            self.held_keys.clear(); self.held_buttons.clear()
            self.unsettled_inputs = False
            self.cleanup_status = "Session closure acknowledged"
            return
        if self.active:
            for key in list(self.held_keys):
                try: self.key(key, False)
                except Exception as error: errors.append("key " + str(key) + ": " + str(error))
            for button in list(self.held_buttons):
                try: self.button(button, False)
                except Exception as error: errors.append("button " + str(button) + ": " + str(error))
        if errors and not self.active and not self.held_keys and not self.held_buttons:
            self.unsettled_inputs = False
            return
        self.unsettled_inputs = bool(errors)
        self.cleanup_status = "Input release unacknowledged" if errors else "Owned input releases acknowledged"
        if errors: raise RuntimeError("Portal input cleanup failed: " + "; ".join(errors))

    def revoke(self, reason, session_closed=False):
        was_granted = self.active or self.session is not None
        # Owner loss is not a Session.Closed acknowledgment. Retain every
        # release obligation until its reply or authoritative closure arrives.
        if session_closed:
            self.held_keys.clear(); self.held_buttons.clear()
        elif self.session and self.transport:
            for key in list(self.held_keys):
                try:
                    self.transport.call("RemoteDesktop", "NotifyKeyboardKeysym", "(oa{sv}iu)", (self.session, {}, key, 0), timeout_ms=200)
                    self.held_keys.discard(key)
                except Exception: pass
            for button in list(self.held_buttons):
                try:
                    self.transport.call("RemoteDesktop", "NotifyPointerButton", "(oa{sv}iu)", (self.session, {}, button, 0), timeout_ms=200)
                    self.held_buttons.discard(button)
                except Exception: pass
        self.active = False; self.devices = 0; self.streams = []
        self.pixel_size = None
        self.capture_facts = {}; self.capture_generation = None
        self.status = reason
        self.unsettled_inputs = bool(self.held_keys or self.held_buttons)
        self.cleanup_status = ("Session closure acknowledged" if session_closed else
                               "Input release unacknowledged; owner loss requires settlement" if self.unsettled_inputs else
                               "Owned input releases acknowledged" )
        errors = self._withdraw_resources(reason, was_granted)
        if errors:
            raise RuntimeError("Portal revocation cleanup failed: " + "; ".join(str(error) for error in errors)) from _cleanup_cause("Portal revocation cleanup failures", errors)

    def _withdraw_resources(self, reason, notify=True):
        errors = []
        if self.capture_pipe:
            try: self.capture_pipe.close()
            except Exception as error: errors.append(error)
            else: self.capture_pipe = None
        if self.fd is not None:
            try: os.close(self.fd)
            except Exception as error: errors.append(error)
            else: self.fd = None
        # Quarantine notification is independent of capture-resource cleanup.
        # A failed close must not leave an expired input owner able to re-enter.
        if notify:
            try: self.revoked(reason)
            except Exception as error: errors.append(error)
        return errors

    def close(self):
        cleanup_error = None
        try: self.cleanup()
        except Exception as error: cleanup_error = error
        session_closed = False
        if self.session and self.transport:
            try:
                self.transport.call("Session", "Close", "()", (), timeout_ms=1000, path=self.session)
                session_closed = True
            except Exception: pass
        if cleanup_error and not session_closed:
            self.active = False; self.devices = 0; self.streams = []; self.pixel_size = None
            self.capture_facts = {}; self.capture_generation = None
            self.unsettled_inputs = True; self.status = "Portal input cleanup and session closure are unconfirmed"
            errors = [cleanup_error, *self._withdraw_resources(self.status)]
            # Keep the transport/session and failed capture resources for a
            # later explicit settlement. No successful input cleanup is claimed.
            raise RuntimeError(self.status + ": " + "; ".join(str(error) for error in errors)) from _cleanup_cause("Portal close cleanup failures", errors)
        errors = []
        try:
            self.revoke("Portal session closed" if session_closed else "Portal transport withdrawn", session_closed=session_closed)
        except Exception as error: errors.append(error)
        if cleanup_error: self.cleanup_status = "Session closure acknowledged after input release failure"
        if self.transport:
            try: self.transport.close()
            except Exception as error: errors.append(error)
            else: self.transport = None
        self.session = None
        if errors:
            raise RuntimeError("Portal close cleanup failed: " + "; ".join(str(error) for error in errors)) from _cleanup_cause("Portal close cleanup failures", errors)
