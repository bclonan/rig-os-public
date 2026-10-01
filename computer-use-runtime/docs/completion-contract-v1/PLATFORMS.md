# Desktop setup on Windows, macOS and Linux

The service chooses its native adapter from the host OS. This computer and One window tasks use the same planner, review controls, journal and restart behavior on each platform. Install the service on the computer you want to control and run it in that user's unlocked desktop session. A browser connected to the service controls the service's computer.

| Host | Implemented operations | Verification |
|---|---|---|
| Windows | UI Automation controls, text, pointer, shortcuts, screenshots and reviewed app navigation | Live Calculator and Notepad tasks with local Qwen 3.6; lifecycle and console tests |
| macOS 14 or newer | Accessibility controls, text, Quartz pointer and Command shortcuts, ScreenCaptureKit screenshots and reviewed app navigation | Implementation checked against Apple documentation and PyObjC binding tests. No Mac was available for native execution |
| Linux X11 | AT-SPI controls, text, XTEST pointer and shortcuts, window screenshots and reviewed app navigation | Live GTK app under Xvfb/Openbox, native effects, shared HTTP runtime and Vue console |
| Linux Wayland | AT-SPI controls, accessible text editing and reviewed app navigation | Live native Wayland GTK app under headless Weston, shared runtime and Vue console. No XWayland fallback |

Wayland currently has no screenshot, global pointer, drag, scroll or shortcut injection. Use accessible controls and text, or log into an X11 session for those operations. Desktop environments and apps can expose different accessibility controls. The planner receives the operations actually available in the session and cannot request an unsupported action. Linux tests used a scripted planner to isolate native behavior; they do not establish local model quality on Linux.

## Common installation

Install Node 24.17 or newer within the Node 24 line. From the `computer-use-runtime` directory, install the dependencies and Chromium used by the console's browser workflow:

```sh
npm ci
npx playwright install chromium
```

Complete the platform steps below, then run:

```sh
npm run setup:desktop
npm run doctor:desktop
npm run build
npm start
```

The desktop doctor checks native dependencies, permissions and visible-window discovery. It does not send input. Read its capability notes if a feature is unavailable. Keep the service terminal open. In another terminal in the same directory, run:

```sh
npm run token
npm run open
```

Paste the token into the console and connect. Install and run Ollama with a capable local model before planning a task. Choose an installed model in the console. Windows development tests used `qwen3.6:latest`; model weights are not bundled or downloaded at startup. An unavailable model does not prevent the service or desktop doctor from starting.

`npm stop` shuts down the service and releases ownership. `npm restart` stops the old process and starts a new one in that terminal. Ctrl+C or entering `stop` also works. Tasks and the token survive. Reconnect the console after a restart. Inspect any interrupted action before resuming it.

## Windows

Source builds need Rust and MSVC Windows build tools. `npm run setup:desktop` builds the Rust bridge. The release archive already includes the Windows x64 binary, so its users can skip that build when using a compatible host.

Run the service and target apps as the same ordinary user. Elevated windows and the secure desktop are outside the supported scope. The fixed launcher includes installed Calculator, Notepad, Paint and File Explorer. Other supported open windows appear in Refresh open apps.

## macOS

Install Python 3.10 or newer on PATH as `python3`. Desktop setup creates `.venv-desktop` and installs the pinned PyObjC Cocoa, Quartz, ApplicationServices and ScreenCaptureKit packages. Apple Silicon and Intel use the same source adapter. No Windows binary runs on macOS.

1. Open System Settings, Privacy & Security, Accessibility. Grant access to the terminal or Python application identified by macOS when it runs this service.
2. For screenshots, also grant Screen Recording access to that application. macOS may call this Screen & System Audio Recording. Accessibility-only tasks can run without screenshots.
3. Quit and reopen that terminal after changing permissions, then run the desktop doctor and restart the service.

The runtime does not change these permissions. Quartz input is offered only when its permission check passes. If macOS refuses to bring an app forward, bring it forward yourself. Bound accessibility actions can still work without global keyboard focus.

The launcher includes Calculator, TextEdit, Finder and Preview when their standard app bundles exist. Command shortcuts use `Meta`, for example `Meta+N` and `Meta+S`; the planner receives those key names automatically.

The adapter uses Apple's public Accessibility, Quartz and ScreenCaptureKit APIs through PyObjC. References include [Accessibility attributes](https://developer.apple.com/documentation/applicationservices/1462060-axuielementcopyattributevalues), [ScreenCaptureKit screenshots](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager), [PyObjC installation](https://pyobjc.readthedocs.io/en/latest/install.html) and the upstream [ScreenCaptureKit binding tests](https://github.com/ronaldoussoren/pyobjc/blob/v12.2.1/pyobjc-framework-ScreenCaptureKit/PyObjCTest/test_scscreenshotmanager.py).

On a Mac, this read-only check verifies the installed framework signatures without capturing a screen or posting input:

```sh
.venv-desktop/bin/python3 evaluation/macos-api-check.py
```

That check has not run in the current Windows/Linux test environment. Granting permissions, capturing Retina windows and executing native Mac tasks still need live Mac validation.

## Linux

On Debian or Ubuntu:

```sh
sudo apt install python3-gi python3-xlib python3-pil gir1.2-atspi-2.0 at-spi2-core xclip wl-clipboard xdg-utils
```

On Fedora:

```sh
sudo dnf install python3-gobject python3-xlib python3-pillow at-spi2-core xclip wl-clipboard xdg-utils
```

The adapter uses `/usr/bin/python3` so it can see distribution-installed GI bindings. `CUR_DESKTOP_PYTHON` can select another interpreter with the same packages. Run from a terminal in your logged-in desktop with its session D-Bus environment. A plain SSH shell or a headless server does not supply that session. If Chromium reports missing libraries, install the dependencies it requests or use `npx playwright install-deps chromium` with the required system privileges.

Enable accessibility in the desktop and target app if controls are absent. The implementation uses [AT-SPI editable text](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/method.Accessible.get_editable_text_iface.html) and, on X11, [python-xlib XTEST](https://github.com/python-xlib/python-xlib/blob/master/Xlib/ext/xtest.py). It skips password fields. X11 screenshots require the selected window to be in front and fully on screen.

The launcher detects a calculator, text editor and file manager from fixed installed executables. It supports common GNOME, KDE and Xfce choices. Launch other applications yourself and select their supported windows. Sandboxed apps may expose fewer controls. On Wayland, activation can be refused by the compositor; bring the target forward when needed.

Token copying uses `wl-copy` on Wayland and `xclip` on X11. `npm run token` works without a clipboard helper. The console opener uses `xdg-open`.

## Repeat the controlled Linux checks

The checked environment was Debian 12 in a disposable Docker container, with system Python 3.11, Node 24.21, AT-SPI2, GTK3, Openbox, Xvfb and Weston. These were real Linux GUI processes, not mocked native APIs. The display servers were virtual, so this does not establish physical multi-monitor or hardware-specific behavior.

Add the test tools on a disposable Debian environment:

```sh
sudo apt install gir1.2-gtk-3.0 xvfb openbox dbus-x11 weston galculator
npm run build
sh evaluation/linux-desktop-run.sh
sh evaluation/linux-wayland-run.sh
node --import tsx evaluation/service-usability.ts
```

The scripts create an owned GTK editor and independent display sessions. They verify actual text and button effects, lease revocation, cleanup, shared HTTP task review, the console and its narrow layout. Reports go to `evidence/linux-*.json`. The lifecycle check starts its own service/store and browser, then exercises token reveal, shutdown, restart, reconnect and a browser fixture task.

`npm test` also covers the common contracts and Python worker checks. Its training-cancellation test requires the optional training environment from `scripts/setup-training.sh` or `scripts/setup-training.ps1`. This desktop-only Linux environment did not install those large training dependencies; that one check is recorded separately in `evidence/linux-regressions.json`. Service training selects `.venv` when present, otherwise `python` on Windows or `python3` elsewhere. `CUR_TRAINING_PYTHON` overrides that interpreter independently of the desktop worker.
