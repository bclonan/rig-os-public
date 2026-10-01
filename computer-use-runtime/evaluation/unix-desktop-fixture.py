"""Disposable GTK window for native Linux tests. No files are edited."""
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
window = Gtk.Window(title="Computer runtime disposable editor")
window.set_default_size(640, 420)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
window.add(box)
entry = Gtk.Entry()
entry.get_accessible().set_name("Test text")
box.pack_start(entry, False, False, 12)
button = Gtk.Button(label="Write marker")
button.connect("clicked", lambda _: entry.set_text("Button verified"))
box.pack_start(button, False, False, 12)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
