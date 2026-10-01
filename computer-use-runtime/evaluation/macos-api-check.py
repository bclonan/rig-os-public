"""Run on macOS to check installed bridge signatures without sending input.

This is not a native task or permission acceptance test.
"""
import json
import platform
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "native/unix"))
import AppKit as K
import Quartz as Q
import HIServices as A
import ScreenCaptureKit as S
from macos import MacDesktop

checks = []
point = A.AXValueCreate(A.kAXValueTypeCGPoint, (12, 24))
ok, value = A.AXValueGetValue(point, A.kAXValueTypeCGPoint, None)
assert ok and tuple(value) == (12, 24)
checks.append("AX point round trip")
for api in (A.AXUIElementCopyAttributeValue, A.AXUIElementCopyActionNames, A.AXUIElementIsAttributeSettable, A.AXUIElementSetAttributeValue, A.AXUIElementPerformAction, Q.CGPreflightScreenCaptureAccess, Q.CGPreflightPostEventAccess):
    assert callable(api)
checks.append("required Accessibility and permission APIs")
event = Q.CGEventCreateKeyboardEvent(None, 0, True)
Q.CGEventKeyboardSetUnicodeString(event, 2, "😀")
length, text = Q.CGEventKeyboardGetUnicodeString(event, 8, None, None)
assert length == 2 and text == "😀"
checks.append("Unicode event encoding; event never posted")
assert callable(S.SCShareableContent.getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler_)
assert callable(S.SCScreenshotManager.captureImageWithFilter_configuration_completionHandler_)
config = S.SCStreamConfiguration.alloc().init()
config.setWidth_(640); config.setHeight_(480); config.setShowsCursor_(False)
assert config.width() == 640 and config.height() == 480
checks.append("ScreenCaptureKit screenshot API and configuration")
assert callable(K.NSBitmapImageRep.alloc().initWithCGImage_)
report = {"status":"PASS", "platform":platform.mac_ver()[0], "evidenceLevel":"macOS API binding check only, no screen capture or input", "checks":checks}
Path("evidence/macos-api.json").write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
