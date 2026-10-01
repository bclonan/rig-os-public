"""Portal protocol/API doubles. These do not establish live Wayland execution."""
import os
import json
import queue
import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "native/unix"))
from portal import DesktopPortal, GioPortalTransport, _PipeWirePipeline as PipeWireCapture
from worker import read_requests
from common import Bridge, PreflightRejected, now
from unix_worker_test import Backend, Lock
from linux import LinuxDesktop
from macos import MacDesktop
from PIL import Image


class Transport:
    def __init__(self, denied=False): self.calls = []; self.denied = denied; self.watch_callback = None
    def request(self, interface, method, signature, arguments, deadline, cancelled):
        self.calls.append((interface, method, arguments))
        if self.denied and method == "Start": raise RuntimeError("Portal permission denied or cancelled")
        if method == "CreateSession": return {"session_handle": "/org/freedesktop/portal/desktop/session/1_1/test"}
        if method == "Start": return {"devices": 3, "streams": [(99, {"position": (100, 200), "size": (800, 600), "source_type": 1})]}
        return {}
    def options(self, value): return value
    def watch(self, session, callback): self.watch_callback = callback
    def pipewire_remote(self, session, _timeout_ms=5000): return os.open(os.devnull, os.O_RDONLY)
    def notify(self, method, signature, arguments): self.calls.append(("RemoteDesktop", method, arguments))
    def call(self, interface, method, signature, arguments, timeout_ms=5000, path=None): self.calls.append((interface, method, arguments))
    def pump(self): pass
    def close(self): pass


class Capture:
    def __init__(self, fd, node): self.closed = False; self.size = (800, 600)
    def image(self, _timeout_ms=2000): return Image.new("RGB", self.size, "white")
    def close(self): self.closed = True


class PortalTests(unittest.TestCase):
    def setUp(self):
        self.transport = Transport(); self.revocations = []
        self.portal = DesktopPortal(self.revocations.append, lambda: self.transport, Capture)
    def tearDown(self): self.portal.close()
    def test_failed_capture_poll_with_held_input_does_not_reenter_cleanup(self):
        self.portal.request_consent()
        self.portal.held_keys={17}; self.portal.held_buttons={1}
        calls=[]
        def failed_poll():
            calls.append('poll'); raise RuntimeError('Capture child exited')
        self.portal.capture_pipe.poll=failed_poll
        self.portal.pump()
        self.assertEqual(calls,['poll'])
        self.assertFalse(self.portal.active); self.assertFalse(self.portal.held_keys); self.assertFalse(self.portal.held_buttons)
        self.assertFalse(self.portal.unsettled_inputs)
        self.assertTrue(any(call[1]=='Close' and call[0]=='Session' for call in self.transport.calls))
        self.assertTrue(self.revocations)
    def test_failed_capture_poll_and_session_close_keep_inputs_without_reentry(self):
        self.portal.request_consent()
        self.portal.held_keys={17}; self.portal.held_buttons={1}
        original = self.transport.call; polls=[]
        def failed_poll():
            polls.append('poll'); raise RuntimeError('Capture child exited')
        def failed_close(*_args, **_kwargs): raise RuntimeError('Session closure unconfirmed')
        self.portal.capture_pipe.poll=failed_poll; self.transport.call=failed_close
        try:
            with self.assertRaisesRegex(RuntimeError, 'unconfirmed'): self.portal.pump()
            self.assertEqual(polls,['poll'])
            self.assertFalse(self.portal.active); self.assertTrue(self.portal.unsettled_inputs)
            self.assertEqual(self.portal.held_keys,{17}); self.assertEqual(self.portal.held_buttons,{1})
            self.assertTrue(self.revocations); self.assertIs(self.portal.transport,self.transport)
        finally: self.transport.call=original
        self.portal.close()
        self.assertFalse(self.portal.unsettled_inputs)
    def test_startup_does_not_prompt_and_consent_shares_one_session(self):
        self.assertEqual(self.transport.calls, [])
        self.portal.request_consent()
        self.assertEqual([c[1] for c in self.transport.calls[:4]], ["CreateSession", "SelectDevices", "SelectSources", "Start"])
        self.assertEqual(self.transport.calls[1][2][0], self.transport.calls[2][2][0])
        self.assertTrue(self.portal.active)
    def test_selected_window_crop_and_pointer_use_verified_stream_relative_coordinates(self):
        self.portal.request_consent()
        frame = dict(x=200, y=250, width=100, height=80, scale=1)
        self.portal.move(frame, 10, 20)
        self.assertEqual(self.transport.calls[-1][2][-2:], (110., 70.))
        import io
        image = Image.open(io.BytesIO(self.portal.capture(frame)))
        self.assertEqual(image.size, (100, 80))
        self.portal.capture_pipe.size = (1600, 1200)
        self.portal.capture(frame)
        with self.assertRaisesRegex(RuntimeError, "scale"): self.portal.move(frame, 10, 20)
        self.portal.streams[0][1].pop("position")
        with self.assertRaisesRegex(RuntimeError, "mapping"): self.portal.capture(frame)
    def test_denial_never_enables_input_and_session_loss_revokes_and_closes_capture(self):
        self.transport.denied = True
        with self.assertRaisesRegex(RuntimeError, "denied"): self.portal.request_consent()
        self.assertFalse(self.portal.active)
        self.assertFalse(any("Notify" in call[1] for call in self.transport.calls))
        self.transport.denied = False; self.portal.request_consent()
        self.portal.key(0xffe1, True); self.portal.button(0x110, True)
        capture = self.portal.capture_pipe
        self.transport.watch_callback("Portal D-Bus owner changed")
        self.assertFalse(self.portal.active); self.assertEqual(self.portal.devices, 0)
        self.assertTrue(capture.closed); self.assertFalse(self.portal.held_keys)
        with self.assertRaisesRegex(RuntimeError, "unavailable"): self.portal.key(0xffe1, False)
    def test_cleanup_releases_owned_keys_buttons_and_respects_granted_device_mask(self):
        self.portal.request_consent()
        self.portal.key(0xffe3, True); self.portal.button(0x110, True); self.portal.cleanup()
        self.assertEqual(self.transport.calls[-2][2][-1], 0)
        self.assertEqual(self.transport.calls[-1][2][-1], 0)
        self.portal.devices = 1
        with self.assertRaises(RuntimeError): self.portal.button(0x110, True)

    def test_owner_loss_keeps_failed_releases_and_bridge_ownership_quarantined(self):
        self.portal.request_consent()
        backend = Backend(); backend.portal = self.portal
        backend.cleanup = self.portal.cleanup
        bridge = Bridge(backend, Lock)
        self.portal.revoked = bridge.portal_revoked
        bridge.call("acquire", {"runId": "owned-run"})
        self.portal.key(0xff0d, True); self.portal.button(0x110, True)
        original = self.transport.call
        def fail_release(interface, method, *args, **kwargs):
            if method.startswith("Notify") or method == "Close":
                raise RuntimeError("Backend disappeared before release acknowledgment")
            return original(interface, method, *args, **kwargs)
        self.transport.call = fail_release
        self.transport.watch_callback("Portal D-Bus owner changed")
        self.assertEqual(self.portal.held_keys, {0xff0d})
        self.assertEqual(self.portal.held_buttons, {0x110})
        self.assertTrue(self.portal.unsettled_inputs)
        self.assertEqual(bridge.owner, "owned-run")
        self.assertTrue(bridge.lock.held); self.assertTrue(bridge.manual)
        self.assertFalse(bridge.call("capabilities", {})["inputCleanup"]["settled"])
        with self.assertRaisesRegex(RuntimeError, "Manual"):
            bridge.call("acquire", {"runId": "another-run"})
        with self.assertRaisesRegex(RuntimeError, "Release active desktop ownership"):
            bridge.call("request_consent", {})
        self.transport.watch_callback("Portal Session.Closed signal", session_closed=True)
        self.assertFalse(self.portal.held_keys); self.assertFalse(self.portal.held_buttons)
        self.assertFalse(self.portal.unsettled_inputs)
        self.assertIsNone(bridge.owner); self.assertFalse(bridge.lock.held)
        self.assertTrue(bridge.call("capabilities", {})["inputCleanup"]["settled"])
        self.transport.call = original
        bridge.call("return", {})
        self.assertFalse(bridge.manual)
        bridge.close()

    def test_capture_close_failure_still_notifies_quarantine_and_closes_fd(self):
        self.portal.request_consent()
        backend = Backend(); backend.portal = self.portal; backend.cleanup = self.portal.cleanup
        bridge = Bridge(backend, Lock); self.portal.revoked = bridge.portal_revoked
        bridge.call("acquire", {"runId": "owned-run"})
        self.portal.key(0xff0d, True); self.portal.button(0x110, True)
        original_call = self.transport.call
        capture = self.portal.capture_pipe; original_close = capture.close
        fd = self.portal.fd
        def failed_release(interface, method, *args, **kwargs):
            if method.startswith("Notify") or method == "Close": raise RuntimeError("Missing release reply")
            return original_call(interface, method, *args, **kwargs)
        def failed_capture_close(): raise RuntimeError("Capture close failed")
        self.transport.call = failed_release; capture.close = failed_capture_close
        try:
            with self.assertRaisesRegex(RuntimeError, "Capture close failed"):
                self.transport.watch_callback("Portal D-Bus owner changed")
            self.assertTrue(self.portal.unsettled_inputs)
            self.assertEqual(self.portal.held_keys, {0xff0d}); self.assertEqual(self.portal.held_buttons, {0x110})
            self.assertTrue(bridge.manual); self.assertEqual(bridge.owner, "owned-run"); self.assertTrue(bridge.lock.held)
            self.assertIs(self.portal.capture_pipe, capture); self.assertIsNone(self.portal.fd)
            with self.assertRaises(OSError): os.fstat(fd)
            bridge.expires = 0
            with self.assertRaisesRegex(RuntimeError, "Manual"):
                bridge.call("acquire", {"runId": "next-run"})
            self.assertIsInstance(self.portal.transport, Transport)
        finally:
            self.transport.call = original_call; capture.close = original_close
            bridge.call("return", {}); bridge.close(); self.portal.close()
        self.assertIsNone(self.portal.capture_pipe)

    def test_unconfirmed_close_attempts_fd_and_callback_after_capture_failure_then_retries(self):
        self.portal.request_consent(); self.portal.key(0xffe3, True)
        capture = self.portal.capture_pipe; original_capture = capture.close
        fd = self.portal.fd; callbacks = []
        self.portal.revoked = callbacks.append
        original_notify = self.transport.notify; original_call = self.transport.call
        def fail_notify(*args): raise RuntimeError("Key up unconfirmed")
        def fail_call(interface, method, *args, **kwargs):
            if method == "Close": raise RuntimeError("Session close unconfirmed")
            return original_call(interface, method, *args, **kwargs)
        def fail_capture(): raise RuntimeError("Capture close failed")
        self.transport.notify = fail_notify; self.transport.call = fail_call; capture.close = fail_capture
        try:
            with self.assertRaisesRegex(RuntimeError, "unconfirmed.*Capture close failed") as error:
                self.portal.close()
            self.assertIsInstance(error.exception.__cause__, RuntimeError)
            self.assertGreaterEqual(len(error.exception.__cause__.exceptions), 2)
            self.assertTrue(callbacks); self.assertTrue(self.portal.unsettled_inputs)
            self.assertEqual(self.portal.held_keys, {0xffe3})
            self.assertIs(self.portal.capture_pipe, capture); self.assertIsNone(self.portal.fd)
            with self.assertRaises(OSError): os.fstat(fd)
            self.assertIs(self.portal.transport, self.transport); self.assertIsNotNone(self.portal.session)
        finally:
            self.transport.notify = original_notify; self.transport.call = original_call; capture.close = original_capture
        self.portal.close()
        self.assertIsNone(self.portal.capture_pipe); self.assertIsNone(self.portal.transport)
        self.assertFalse(self.portal.unsettled_inputs); self.assertFalse(self.portal.held_keys)

    def test_confirmed_session_close_attempts_transport_after_capture_failure(self):
        self.portal.request_consent()
        capture = self.portal.capture_pipe; original_capture = capture.close
        original_transport_close = self.transport.close; attempts = []
        def fail_capture(): raise RuntimeError("Capture close failed")
        def close_transport(): attempts.append("transport"); original_transport_close()
        capture.close = fail_capture; self.transport.close = close_transport
        try:
            with self.assertRaisesRegex(RuntimeError, "Capture close failed"):
                self.portal.close()
            self.assertEqual(attempts, ["transport"])
            self.assertIsNone(self.portal.transport); self.assertIsNone(self.portal.session); self.assertIsNone(self.portal.fd)
            self.assertIs(self.portal.capture_pipe, capture)
            self.assertFalse(self.portal.unsettled_inputs)
        finally:
            capture.close = original_capture; self.transport.close = original_transport_close
        self.portal.close()
        self.assertIsNone(self.portal.capture_pipe)

    def test_fd_close_and_callback_failures_do_not_skip_other_owned_resource_cleanup(self):
        self.portal.request_consent()
        capture = self.portal.capture_pipe; fd = self.portal.fd
        original_close = os.close
        calls = []
        def fail_fd(value):
            if value == fd: raise OSError("FD close failed")
            return original_close(value)
        def fail_callback(reason):
            calls.append(reason); raise RuntimeError("Callback failed")
        self.portal.revoked = fail_callback
        os.close = fail_fd
        try:
            with self.assertRaisesRegex(RuntimeError, "FD close failed.*Callback failed") as error:
                self.portal.revoke("Authoritative closed session", session_closed=True)
            self.assertEqual(len(error.exception.__cause__.exceptions), 2)
            self.assertTrue(capture.closed); self.assertIsNone(self.portal.capture_pipe)
            self.assertEqual(self.portal.fd, fd); self.assertTrue(calls)
            self.assertFalse(self.portal.unsettled_inputs)
        finally:
            os.close = original_close; self.portal.revoked = self.revocations.append
        self.portal.close()
        self.assertIsNone(self.portal.fd)

    def test_owner_loss_discards_only_acknowledged_releases(self):
        self.portal.request_consent()
        self.portal.key(0xff0d, True); self.portal.button(0x110, True)
        original = self.transport.call
        def fail_button(interface, method, *args, **kwargs):
            if method == "NotifyPointerButton": raise RuntimeError("No button-up reply")
            return original(interface, method, *args, **kwargs)
        self.transport.call = fail_button
        self.transport.watch_callback("Portal D-Bus owner changed")
        self.assertFalse(self.portal.held_keys)
        self.assertEqual(self.portal.held_buttons, {0x110})
        self.assertTrue(self.portal.unsettled_inputs)
        self.transport.call = original
        self.portal.close()
        self.assertFalse(self.portal.unsettled_inputs)
        self.assertFalse(self.portal.held_buttons)

    def test_failed_up_is_retained_until_retry_or_confirmed_session_close(self):
        self.portal.request_consent(); self.portal.key(0xffe3, True); self.portal.button(0x110, True)
        original = self.transport.notify
        def fail_up(method, signature, args):
            if args[-1] == 0: raise RuntimeError("Release acknowledgement failed")
            return original(method, signature, args)
        self.transport.notify = fail_up
        with self.assertRaisesRegex(RuntimeError, "cleanup failed"): self.portal.cleanup()
        self.assertEqual(self.portal.held_keys, {0xffe3}); self.assertEqual(self.portal.held_buttons, {0x110})
        self.assertTrue(self.portal.unsettled_inputs); self.assertTrue(self.portal.active)
        self.transport.notify = original; self.portal.cleanup()
        self.assertFalse(self.portal.held_keys); self.assertFalse(self.portal.held_buttons); self.assertFalse(self.portal.unsettled_inputs)
        self.portal.key(0xffe3, True); self.transport.notify = fail_up
        original_call = self.transport.call
        def fail_close(interface, method, *args, **kwargs):
            if interface == "Session" and method == "Close": raise RuntimeError("Session close failed")
            return original_call(interface, method, *args, **kwargs)
        self.transport.call = fail_close
        with self.assertRaisesRegex(RuntimeError, "unconfirmed"): self.portal.close()
        self.assertEqual(self.portal.held_keys, {0xffe3}); self.assertTrue(self.portal.unsettled_inputs)
        self.transport.call = original_call; self.portal.close()
        self.assertFalse(self.portal.held_keys); self.assertFalse(self.portal.unsettled_inputs); self.assertFalse(self.portal.active)

    def test_capture_only_grant_has_no_input_and_linux_mapping_requires_full_monitor(self):
        self.portal.request_consent()
        backend = LinuxDesktop.__new__(LinuxDesktop); backend.portal = self.portal
        frame = dict(x=100,y=200,width=800,height=600,scale=1)
        backend.portal_frame({"frame": frame})
        with self.assertRaisesRegex(RuntimeError, "origin is unverified"):
            backend.portal_frame({"frame": {**frame, "width": 700}})
        self.portal.devices = 0
        with self.assertRaises(RuntimeError): self.portal.key(0xff0d, True)
        self.assertTrue(self.portal.capture(frame))

    def test_lost_down_reply_still_owns_release_obligation(self):
        self.portal.request_consent()
        original = self.transport.notify
        def lost_reply(method, signature, args):
            original(method, signature, args)
            if args[-1] == 1: raise RuntimeError("Down delivered but reply lost")
        self.transport.notify = lost_reply
        with self.assertRaisesRegex(RuntimeError, "reply lost"): self.portal.key(0xffe3, True)
        with self.assertRaisesRegex(RuntimeError, "reply lost"): self.portal.button(0x110, True)
        self.assertEqual(self.portal.held_keys, {0xffe3}); self.assertEqual(self.portal.held_buttons, {0x110})
        self.portal.cleanup()
        self.assertFalse(self.portal.held_keys); self.assertFalse(self.portal.held_buttons)
        self.assertEqual([call[2][-1] for call in self.transport.calls[-2:]], [0, 0])


class SharedWorkerBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.backend = Backend(); self.bridge = Bridge(self.backend, Lock)
        self.bridge.call("bind", {"handle":1,"pid":9})
    def tearDown(self): self.bridge.close()
    def action(self, operation="click"):
        observation = self.bridge.call("observe", {})
        generation = self.bridge.call("acquire", {"runId":"run"})["generation"]
        return {"runId":"run","generation":generation,"host":observation["host"],"session":observation["session"],
            "target":observation["target"],"observationId":observation["id"],"revision":observation["revision"],"frame":observation["frame"],
            "deadline":now()+10000,"scope":"edit","operation":operation,"args":{"x":20,"y":20}}
    def test_changed_controls_and_changed_pixels_each_reject_cached_pointer_before_effect(self):
        action = self.action(); self.backend.value = "Changed after observe"
        with self.assertRaisesRegex(RuntimeError, "content changed"): self.bridge.call("execute", action)
        action = self.action(); self.backend.capture = lambda _window: b"Changed image bytes"
        with self.assertRaisesRegex(RuntimeError, "content changed"): self.bridge.call("execute", action)
        self.assertEqual(self.backend.sent, [])
    def test_incoherent_capture_does_not_publish_an_observation(self):
        def change(_window): self.backend.value += "x"; return b"Captured pixels"
        self.backend.capture = change
        with self.assertRaisesRegex(RuntimeError, "not coherent"): self.bridge.call("observe", {})
        self.assertIsNone(self.bridge.last)
    def test_failed_cleanup_quarantines_owned_lock_and_return_retries_before_reallow(self):
        action = self.action()
        original = self.backend.cleanup
        def fail(): raise RuntimeError("Owned key up failed")
        self.backend.cleanup = fail
        with self.assertRaisesRegex(RuntimeError, "quarantined"): self.bridge.call("execute", action)
        self.assertTrue(self.bridge.lock.held); self.assertTrue(self.bridge.manual); self.assertEqual(self.bridge.owner, "run")
        with self.assertRaises(RuntimeError): self.bridge.call("acquire", {"runId":"next"})
        with self.assertRaisesRegex(RuntimeError, "cleanup failed"): self.bridge.call("return", {})
        self.assertTrue(self.bridge.lock.held); self.assertTrue(self.bridge.manual)
        self.backend.cleanup = original; self.bridge.call("return", {})
        self.assertFalse(self.bridge.lock.held); self.assertFalse(self.bridge.manual); self.assertIsNone(self.bridge.owner)

    def test_rejection_binds_action_and_run_but_after_dispatch_failure_stays_uncertain(self):
        action = {**self.action(), "id": "action-7"}; self.backend.value = "New text"
        with self.assertRaises(PreflightRejected) as rejected: self.bridge.call("execute", action)
        self.assertEqual(rejected.exception.receipt, {"actionId":"action-7","runId":"run","backend":"test-double",
            "phase":"rejected","dispatched":False,"delivered":False,"reason":"Desktop content changed after observation"})
        self.assertEqual(self.backend.sent, [])
        action = {**self.action(), "id": "action-8"}
        def lose_reply(_window, _op, _args, guard):
            guard(); self.backend.sent.append("click"); raise RuntimeError("Native reply lost after dispatch")
        self.backend.execute = lose_reply
        with self.assertRaisesRegex(RuntimeError, "after dispatch") as uncertain: self.bridge.call("execute", action)
        self.assertNotIsInstance(uncertain.exception, PreflightRejected)
        self.assertEqual(self.backend.sent, ["click"])

    def test_cached_portal_image_never_authorizes_global_input(self):
        self.backend.portal = SimpleNamespace(unsettled_inputs=False)
        self.backend.capture_facts = {"pixelFrameCached":True,"pixelCapturedAt":now(),"pipewireSessionGeneration":"granted-1"}
        action = self.action()
        with self.assertRaisesRegex(PreflightRejected, "cached frames") as rejected: self.bridge.call("execute", action)
        self.assertFalse(rejected.exception.receipt["dispatched"]); self.assertEqual(self.backend.sent, [])


class CaptureCacheTests(unittest.TestCase):
    def test_static_cache_keeps_original_time_and_is_invalidated_on_close(self):
        capture = PipeWireCapture.__new__(PipeWireCapture)
        capture.closed = False; capture.last_image = Image.new("RGB", (2,2), "red"); capture.sequence = 7
        original = {"pixelCapturedAt":123,"pixelReceivedAt":130,"pixelFrameSequence":7,"pixelFrameCached":False}
        capture.metadata = dict(original)
        capture.Gst = SimpleNamespace(MSECOND=1,MessageType=SimpleNamespace(ERROR=1,EOS=2),State=SimpleNamespace(NULL=0))
        capture.sink = SimpleNamespace(emit=lambda *_args: None)
        bus = SimpleNamespace(pop_filtered=lambda _types: None)
        capture.pipeline = SimpleNamespace(get_bus=lambda:bus,set_state=lambda _state:None)
        self.assertEqual(capture.image(0).getpixel((0,0)), (255,0,0))
        self.assertEqual(capture.metadata, {**original,"pixelFrameCached":True}); self.assertEqual(capture.sequence, 7)
        capture.close(); self.assertIsNone(capture.last_image); self.assertEqual(capture.metadata,{})
        with self.assertRaisesRegex(RuntimeError, "closed"): capture.image(0)


class NativeReleaseFailureTests(unittest.TestCase):
    def test_x11_failed_sync_retains_owned_key_and_button_until_retry(self):
        backend = LinuxDesktop.__new__(LinuxDesktop)
        backend.held_keys={17}; backend.held_buttons={1}; backend.portal=None
        backend.X=SimpleNamespace(KeyPress=1,KeyRelease=2,ButtonPress=3,ButtonRelease=4)
        calls=[]; backend.xtest=SimpleNamespace(fake_input=lambda *_args:calls.append(_args[1:]))
        def fail_sync(): raise RuntimeError("X11 release sync failed")
        backend.x=SimpleNamespace(sync=fail_sync)
        for _ in range(2):
            with self.assertRaisesRegex(RuntimeError, "sync failed"): backend.cleanup()
            self.assertEqual(backend.held_keys,{17}); self.assertEqual(backend.held_buttons,{1})
        backend.x.sync=lambda:None; backend.cleanup()
        self.assertFalse(backend.held_keys); self.assertFalse(backend.held_buttons)
        self.assertIn((2,17),calls); self.assertIn((4,1),calls)

    def test_quartz_failed_release_creation_retains_keys_and_mouse_until_post_completes(self):
        backend = MacDesktop.__new__(MacDesktop)
        backend.held_keys={17}; backend.held_mouse=True; backend.last_point=(10,20)
        posted=[]
        backend.Q=SimpleNamespace(kCGEventLeftMouseDown=1,kCGEventLeftMouseUp=2,kCGMouseButtonLeft=0,kCGHIDEventTap=0,
            CGEventCreateKeyboardEvent=lambda *_args:None,CGEventCreateMouseEvent=lambda *_args:None,
            CGEventSetFlags=lambda *_args:None,CGEventPost=lambda _tap,event:posted.append(event))
        for _ in range(2):
            with self.assertRaisesRegex(RuntimeError,"creation failed"): backend.cleanup()
            self.assertEqual(backend.held_keys,{17}); self.assertTrue(backend.held_mouse)
        with self.assertRaisesRegex(RuntimeError,"mouse event creation failed"): backend.mouse(2,(10,20))
        self.assertTrue(backend.held_mouse); self.assertEqual(posted,[])
        backend.Q.CGEventCreateKeyboardEvent=lambda *_args:"key-up"
        backend.Q.CGEventCreateMouseEvent=lambda *_args:"mouse-up"
        backend.cleanup()
        self.assertFalse(backend.held_keys); self.assertFalse(backend.held_mouse); self.assertEqual(posted,["key-up","mouse-up"])


class Variant:
    def __init__(self, signature, value): self.value = value
    def unpack(self): return self.value


class FakeBus:
    def __init__(self): self.subscriptions = {}; self.calls = []; self.respond = True
    def get_unique_name(self): return ":1.9"
    def signal_subscribe(self, sender, interface, signal, path, arg, flags, callback, user):
        number = len(self.subscriptions) + 1; self.subscriptions[number] = callback; return number
    def signal_unsubscribe(self, number): self.subscriptions.pop(number)
    def call_sync(self, name, path, interface, method, parameters, result, flags, timeout, cancellable):
        self.calls.append(method)
        if method == "Close": return Variant("()", ())
        token = parameters.value[-1]["handle_token"].value
        handle = "/org/freedesktop/portal/desktop/request/1_9/" + token
        if self.respond:
            # Deliver before call_sync returns to test the subscription race.
            for callback in list(self.subscriptions.values()): callback(self, name, handle, interface, "Response", Variant("(ua{sv})", (0, {"answer": 42})), None)
        return Variant("(o)", (handle,))


class RequestRaceTests(unittest.TestCase):
    def transport(self):
        transport = GioPortalTransport.__new__(GioPortalTransport)
        transport.bus = FakeBus(); transport.GLib = SimpleNamespace(Variant=Variant)
        transport.Gio = SimpleNamespace(DBusCallFlags=SimpleNamespace(NONE=0), DBusSignalFlags=SimpleNamespace(NONE=0))
        transport.context = SimpleNamespace(pending=lambda: False); transport.subscriptions = []
        return transport
    def test_response_before_return_is_received_and_listener_is_removed(self):
        transport = self.transport()
        self.assertEqual(transport.request("RemoteDesktop", "CreateSession", "(a{sv})", ({},), time.monotonic()+1), {"answer": 42})
        self.assertFalse(transport.bus.subscriptions)
    def test_request_close_settles_without_response(self):
        transport = self.transport(); transport.bus.respond = False
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, "cancelled"):
            transport.request("RemoteDesktop", "CreateSession", "(a{sv})", ({},), time.monotonic()+1, lambda: True)
        self.assertLess(time.monotonic()-started, .2)
        self.assertIn("Close", transport.bus.calls)
        self.assertFalse(transport.bus.subscriptions)


class WorkerCancellationTests(unittest.TestCase):
    transport = RequestRaceTests.transport
    def test_stop_takeover_cancel_and_parent_eof_interrupt_pending_request(self):
        for method in ("stop", "takeover", "cancel_consent", None):
            with self.subTest(method=method):
                ready = threading.Event(); requests = queue.Queue()
                cancellation = {"sequence": 0, "closed": False}
                def lines():
                    yield json.dumps({"id": 1, "method": "request_consent"}) + "\n"
                    ready.wait(1)
                    if method: yield json.dumps({"id": 2, "method": method}) + "\n"
                reader = threading.Thread(target=read_requests, args=(lines(), requests, cancellation))
                reader.start()
                request, sequence, error = requests.get(timeout=1)
                self.assertEqual(request["method"], "request_consent"); self.assertIsNone(error)
                transport = self.transport(); transport.bus.respond = False
                timer = threading.Timer(.02, ready.set); timer.start()
                started = time.monotonic()
                with self.assertRaisesRegex(RuntimeError, "cancelled"):
                    transport.request("RemoteDesktop", "Start", "(a{sv})", ({},), time.monotonic()+1,
                        lambda: cancellation["closed"] or cancellation["sequence"] > sequence)
                self.assertLess(time.monotonic()-started, .2)
                self.assertIn("Close", transport.bus.calls)
                reader.join(1); timer.join(1); self.assertFalse(reader.is_alive())


if __name__ == "__main__": unittest.main()
