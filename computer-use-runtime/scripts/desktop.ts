import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/storage/index.js";
import { WindowsAdapter } from "../src/adapters/native.js";
import { UnixAdapter, desktopPython } from "../src/adapters/unix.js";

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      result.error?.message || `${command} exited with ${result.status}`,
    );
}
const [command = "doctor"] = process.argv.slice(2);
try {
  if (command === "setup") {
    if (process.platform === "win32")
      run("cargo", [
        "build",
        "--release",
        "--manifest-path",
        "native/Cargo.toml",
      ]);
    else if (process.platform === "darwin") {
      run("python3", [
        "-c",
        "import sys; sys.exit('Install Python 3.10 or newer before desktop setup') if sys.version_info < (3,10) else None",
      ]);
      if (!existsSync(".venv-desktop/bin/python3"))
        run("python3", ["-m", "venv", ".venv-desktop"]);
      run(resolve(".venv-desktop/bin/python3"), [
        "-m",
        "pip",
        "install",
        "-r",
        "native/unix/requirements-macos.txt",
      ]);
      console.log(
        "macOS adapter installed. Grant Accessibility access to the terminal/Python app running the service. Screen Recording is needed only for screenshots. Then run npm run doctor:desktop.",
      );
    } else if (process.platform === "linux") {
      console.log(
        "Linux needs the desktop's AT-SPI bus and system Python packages. Debian/Ubuntu: sudo apt install python3-gi python3-xlib python3-pil gir1.2-atspi-2.0 at-spi2-core xclip wl-clipboard xdg-utils gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-base\nFedora: sudo dnf install python3-gobject python3-xlib python3-pillow at-spi2-core xclip wl-clipboard xdg-utils gstreamer1-plugins-base pipewire-gstreamer\nRun this from your logged-in desktop session. Wayland global input and capture need an installed XDG RemoteDesktop portal backend and explicit consent. Run npx tsx scripts/desktop.ts consent to test the prompt. The doctor closes its temporary session when it exits.",
      );
      run(desktopPython(), [
        "-c",
        "import gi; gi.require_version('Atspi','2.0'); from gi.repository import Atspi; import Xlib; from PIL import Image; print('Linux adapter dependencies are installed')",
      ]);
    } else
      throw new Error("Supported desktop hosts are Windows, macOS and Linux");
  } else if (command === "doctor" || command === "consent") {
    const store = new Store(mkdtempSync(join(tmpdir(), "cur-desktop-doctor-")));
    let adapter: WindowsAdapter | UnixAdapter | undefined;
    try {
      adapter =
        process.platform === "win32"
          ? new WindowsAdapter(store, false)
          : new UnixAdapter(store);
      await adapter.start(0);
      if (command === "consent")
        console.log(
          JSON.stringify(
            await adapter.client.call(
              "request_consent",
              { timeoutMs: 60000 },
              65000,
            ),
            null,
            2,
          ),
        );
      const caps = await adapter.client.call("capabilities");
      const windows = await adapter.client.call("windows");
      console.log(
        JSON.stringify(
          {
            available: true,
            platform: adapter.platform,
            ...caps,
            visibleWindows: windows.length,
          },
          null,
          2,
        ),
      );
    } finally {
      await adapter?.close();
      store.close();
    }
  } else throw new Error("Use setup, doctor or consent");
} catch (e) {
  console.error(String(e));
  process.exitCode = 1;
}
