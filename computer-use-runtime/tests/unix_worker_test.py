import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "native/unix"))
from common import Bridge, COMMON_KEYS, META_KEYS, now
from macos import MacDesktop

class Lock:
    def __init__(self, _session): self.held = False
    def acquire(self): self.held = True
    def release(self): self.held = False
    def close(self): self.release()

class Backend:
    platform = "macOS"; name = "test-double"; session = "test-session"
    operations = ["click", "fill", "type", "invoke", "key", "scroll", "drag"]
    keys = COMMON_KEYS + META_KEYS; screenshot_status = "fixture"; notes = ""
    def __init__(self):
        self.window = dict(handle=1, pid=9, title="Test", executable="test", frame=dict(x=0,y=0,width=200,height=100,scale=1))
        self.focus = True; self.value = ""; self.sent = []; self.cleaned = 0
    def windows(self): return [copy.deepcopy(self.window)]
    def controls(self, _w):
        return [dict(index=0,id="editor",name="Text",value=self.value,controlType=50004,focused=True,offscreen=False,actions=["fill","click"],bounds=dict(x=0,y=0,width=200,height=100))]
    def capture(self, _w): return b"PNG fixture"
    def focused(self, _w): return self.focus
    def cleanup(self): self.cleaned += 1
    def execute(self, w, op, args, guard): guard(); self.sent.append(op)
    def close(self): pass

class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.backend = Backend(); self.bridge = Bridge(self.backend, Lock)
        self.bridge.call("bind", dict(handle=1,pid=9))
    def tearDown(self): self.bridge.close()
    def action(self, operation="fill", args=None):
        o=self.bridge.call("observe", {})
        generation=self.bridge.call("acquire", {"runId":"run"})["generation"]
        return dict(runId="run",generation=generation,host=o["host"],session=o["session"],target=o["target"],observationId=o["id"],revision=o["revision"],frame=o["frame"],deadline=now()+10000,scope="edit",operation=operation,args=args or {"locator":"editor","value":"hello"})
    def test_stop_confirms_cleanup_only_after_owned_input_release(self):
        self.action()
        result = self.bridge.call("stop", {})
        self.assertEqual(result, {"manual": True, "heldInputsReleased": True})
        self.assertFalse(self.bridge.lock.held)
        self.assertIsNone(self.bridge.owner)
        self.assertTrue(self.bridge.manual)
    def test_stop_failure_does_not_confirm_release_or_remove_quarantine(self):
        self.action()
        original = self.backend.cleanup
        def fail(): raise RuntimeError("Injected key-up failure")
        self.backend.cleanup = fail
        try:
            with self.assertRaisesRegex(RuntimeError, "cleanup failed"):
                self.bridge.call("stop", {})
            self.assertTrue(self.bridge.lock.held)
            self.assertTrue(self.bridge.manual)
        finally:
            self.backend.cleanup = original
            self.bridge.call("stop", {})
    def test_host_session_frame_observation_and_generation_binding(self):
        for key,value in [("host","other"),("session","other"),("target","2"),("observationId","wrong"),("revision","changed"),("generation",999),("runId","other"),("frame",{})]:
            a=self.action();a[key]=value
            with self.assertRaises(RuntimeError):self.bridge.call("execute",a)
        self.assertEqual(self.backend.sent,[])
    def test_deadline_expiry_and_stale_snapshot(self):
        a=self.action();a["deadline"]=now()-1
        with self.assertRaises(RuntimeError):self.bridge.call("execute",a)
        a=self.action();self.bridge.last["at"]-=3000
        with self.assertRaises(RuntimeError):self.bridge.call("execute",a)
    def test_window_replacement_or_changed_control_rejects_input(self):
        a=self.action();self.backend.window["pid"]=10
        with self.assertRaises(RuntimeError):self.bridge.call("execute",a)
        self.backend.window["pid"]=9
        a=self.action();self.backend.value="User changed it"
        with self.assertRaisesRegex(RuntimeError,"changed"):self.bridge.call("execute",a)
    def test_focus_required_for_global_input_but_not_bound_semantic_fill(self):
        a=self.action("click",{"x":20,"y":20});self.backend.focus=False
        with self.assertRaisesRegex(RuntimeError,"focus"):self.bridge.call("execute",a)
        a=self.action();self.bridge.call("execute",a)
        self.assertEqual(self.backend.sent,["fill"])
    def test_command_save_needs_save_permission_and_consumes_observation(self):
        a=self.action("key",{"key":"Meta+S"})
        with self.assertRaisesRegex(RuntimeError,"save"):self.bridge.call("execute",a)
        a["scope"]="save";self.bridge.call("execute",a)
        with self.assertRaises(RuntimeError):self.bridge.call("execute",a)
        self.assertEqual(self.backend.sent,["key"])
    def test_takeover_releases_and_revokes_stale_generation(self):
        a=self.action();self.bridge.call("takeover",{})
        self.assertFalse(self.bridge.lock.held)
        with self.assertRaises(RuntimeError):self.bridge.call("execute",a)
        self.bridge.call("return",{});self.bridge.call("acquire",{"runId":"run"})
        with self.assertRaises(RuntimeError):self.bridge.call("execute",a)
    def test_actions_are_bounded_and_no_executable_protocol(self):
        for op,args in [("shell",{"command":"bad"}),("click",{"x":250,"y":20}),("drag",{"x":1,"y":1,"dx":-1,"dy":1}),("scroll",{"amount":0}),("type",{"text":"x"*129}),("key",{"key":"Meta+R"})]:
            with self.assertRaises(RuntimeError):self.bridge.call("execute",self.action(op,args))
    def test_adapter_capabilities_are_not_invented(self):
        self.backend.operations=["fill","invoke"]
        caps=self.bridge.call("capabilities",{})
        self.assertEqual(caps["operations"],["fill","invoke"])
        with self.assertRaises(RuntimeError):self.bridge.call("execute",self.action("click",{"x":1,"y":1}))

class MacEventTests(unittest.TestCase):
    def test_unicode_events_use_utf16_length_and_cleanup_only_held_inputs(self):
        # API double verifies arguments, not native macOS execution.
        class Quartz:
            kCGHIDEventTap=0
            def __init__(self): self.events=[];self.unicode=[]
            def CGEventCreateKeyboardEvent(self,_source,code,down): return {"code":code,"down":down}
            def CGEventSetFlags(self,e,flags):e["flags"]=flags
            def CGEventKeyboardSetUnicodeString(self,e,length,text):self.unicode.append((length,text))
            def CGEventPost(self,_tap,e):self.events.append(e)
        m=MacDesktop.__new__(MacDesktop);m.Q=Quartz();m.held_keys=set();m.held_mouse=False
        m.post_key(0,True,text="😀");m.cleanup()
        self.assertEqual(m.Q.unicode,[(2,"😀")])
        self.assertEqual([(e["code"],e["down"]) for e in m.Q.events],[(0,True),(0,False)])
        m.cleanup();self.assertEqual(len(m.Q.events),2)

if __name__ == "__main__":unittest.main()
