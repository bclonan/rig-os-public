"""Owned fullscreen Wayland fixture. GTK callbacks supply independent effects."""
import json
import os
from pathlib import Path
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib
Gtk.Settings.get_default().set_property("gtk-cursor-blink", False)

directory = Path(os.environ.get("EVIDENCE_DIR", "/evidence/mutter"))
state = {"text": "", "markerClicks": 0, "pointerPresses": 0, "pointerReleases": 0,
         "pointerMoves": [], "scrollEvents": 0, "keyDown": [], "keyUp": []}
def save():
    temporary = directory / "fixture-state.tmp"
    temporary.write_text(json.dumps(state))
    temporary.replace(directory / "fixture-state.json")

window = Gtk.Window(title="Computer runtime portal fixture")
window.fullscreen()
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
window.add(box)
entry = Gtk.Entry()
entry.get_accessible().set_name("Portal text")
entry.connect("changed", lambda item: (state.update(text=item.get_text()), save()))
box.pack_start(entry, False, False, 12)
button = Gtk.Button(label="Portal marker")
def marker(_button):
    state["markerClicks"] += 1
    entry.set_text("Portal button verified")
    save()
button.connect("clicked", marker)
box.pack_start(button, False, False, 12)
canvas = Gtk.DrawingArea()
canvas.set_size_request(400, 250)
canvas.get_accessible().set_name("Portal canvas")
canvas.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK |
                  Gdk.EventMask.POINTER_MOTION_MASK | Gdk.EventMask.SCROLL_MASK | Gdk.EventMask.SMOOTH_SCROLL_MASK)
def pointer(_canvas, event):
    if event.type == Gdk.EventType.BUTTON_PRESS: state["pointerPresses"] += 1
    if event.type == Gdk.EventType.BUTTON_RELEASE: state["pointerReleases"] += 1
    if event.type == Gdk.EventType.MOTION_NOTIFY and event.state & Gdk.ModifierType.BUTTON1_MASK:
        state["pointerMoves"].append([round(event.x), round(event.y)])
    save(); return False
for name in ("button-press-event", "button-release-event", "motion-notify-event"):
    canvas.connect(name, pointer)
def scroll(_canvas, _event):
    state["scrollEvents"] += 1; save(); return True
canvas.connect("scroll-event", scroll)
def draw(_canvas, context):
    context.set_source_rgb(.12, .4, .22); context.paint()
    context.set_source_rgb(1, 1, 1); context.move_to(20, 50)
    context.show_text("Owned portal input fixture")
canvas.connect("draw", draw)
box.pack_start(canvas, True, True, 12)
def key(_window, event):
    field = "keyDown" if event.type == Gdk.EventType.KEY_PRESS else "keyUp"
    state[field].append(Gdk.keyval_name(event.keyval)); save(); return False
window.connect("key-press-event", key)
window.connect("key-release-event", key)
window.connect("destroy", Gtk.main_quit)
def presentation():
    if (directory / "fixture-present").exists():
        (directory / "fixture-present").unlink()
        window.present(); entry.grab_focus()
        state["active"] = window.is_active(); save()
    return True
GLib.timeout_add(20, presentation)
# The live global-input profile needs new compositor frames. Repainting the
# same fixture pixels makes that requirement explicit without changing targets.
# The evaluator pauses this source to test truthful static-frame rejection.
def repaint():
    if not (directory / "fixture-static").exists(): canvas.queue_draw()
    return True
GLib.timeout_add(40, repaint)
window.show_all(); entry.grab_focus(); save()
Gtk.main()
