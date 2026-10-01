# Desktop setup on Windows, macOS and Linux

The pre-publication working tree had 300 maintained files and SHA-256 `31667d67fa52f874bc6cdcbdafc88b33a10865ef741217513a495bbfd4248700`. Checkpoint HEAD was `25690943` before publication changes. [docs/REPAIR_STATUS.md](docs/REPAIR_STATUS.md) and [docs/VERIFICATION.md](docs/VERIFICATION.md) separate current checks from the historical 273-file release. Native Mac execution, physical mixed-DPI qualification and general native learning remain open.

The service chooses its native adapter from the host OS. This computer and One window tasks use the same planner, review controls, journal and restart behavior on each platform. Install the service on the computer you want to control and run it in that user's unlocked desktop session. A browser connected to the service controls the service's computer.

The [earlier eight-command quality check](../docs/open-source/EVIDENCE.md) passed at the 300-file fingerprint, with 327 TypeScript tests and 87 Python cases including 18 Windows platform skips. Seven-command fresh Windows source installation remains the earlier 299-file execution. The native ten-effect run retains its earlier 296-file source binding. The Linux capture process has a separate 51-test peer. Its real 20-check qualification remains the earlier 299-file execution in one private Mutter 43.8 scale-1 virtual monitor. Earlier profiles keep their historical source bindings. This does not certify every desktop or model. The original sealed audit and frozen September 30 ZIP remain unchanged. Their 61/63 ledger result is historical.

| Host | Implemented operations | Effect evidence and current limit |
|---|---|---|
| Windows | UI Automation controls, text, pointer, shortcuts, screenshots and reviewed app navigation; WinEvent metadata and bounded changed-region comparison | Live Calculator and Notepad tasks with local Qwen 3.6; owned native effect and two-display transfer development checks. Event/cache qualification is separate |
| macOS 14 or newer | Accessibility controls, text, Quartz pointer and Command shortcuts, ScreenCaptureKit screenshots and reviewed app navigation | Implementation checked against Apple documentation and PyObjC binding tests. No Mac was available for native execution |
| Linux X11 | AT-SPI controls, text, XTEST pointer and shortcuts, window screenshots and reviewed app navigation | Live GTK app under Xvfb/Openbox, native effects, shared HTTP runtime and Vue console |
| Linux Wayland | AT-SPI controls and accessible text; explicit RemoteDesktop/ScreenCast consent adds granted devices and PipeWire capture under the tested coordinate profile | Real Mutter/GNOME portal consent and GTK effects on one scale-1 fullscreen virtual monitor. Earlier Weston control-only checks remain historical. No XWayland fallback |

Wayland starts with accessible controls and text only. Portal input and screenshots require an installed XDG RemoteDesktop backend, PipeWire/GStreamer and explicit user consent. The adapter advertises only the devices actually granted. A capture-only grant cannot authorize keyboard or pointer input. Desktop environments and apps expose different accessibility controls. Linux native evaluations use scripted actions to isolate OS behavior; they do not establish local model quality on Linux.

The completed 299-file V4 replay passed its browser metrics but failed activation on original trainer provenance. The earlier 300-file V4 qualification and explicit seed-17 activation passed. [The primary receipt](../docs/open-source/EVIDENCE.md) records all three command exits as zero and settled cleanup. [Independent metric review](../docs/open-source/EVIDENCE.md) and [whole-current review](../docs/open-source/EVIDENCE.md) verify all 2,100 tasks, 300 head cases, exact selected weights, current source and signed finalization. [A separate public-operation supplement](../docs/open-source/EVIDENCE.md) completed one browser task with two bound acknowledgments and an independently read result, then rolled back to `fixed`. These are exposed-case source requalification and disposable-Store checks. They do not train new weights, activate the user's Store or establish unseen-task or native learning. This does not expand native model or platform scope.

The [300-file physical preparation](../docs/open-source/EVIDENCE.md) is a separate UNRUN method. Its twelve filesystem discovery checks passed; the original 24 effect/profile assertions, 90-second effects and 120-second restoration limits are unchanged. The [independent whole-method peer](../docs/open-source/EVIDENCE.md) is closed. Live input still requires the ownership preconditions and explicit root foreground release. The physical gate remains FAIL. The last saved Settings window is unowned and must not be controlled or closed as preparation.

## Common installation

[Setup, startup and operation](docs/RUNNING.md) provides complete first-install and daily-use instructions, token commands, model setup, backup and troubleshooting. This page covers native prerequisites and tested platform limits.

Install Node 24.17 or newer within the Node 24 line. From the `computer-use-runtime` directory, install the dependencies and Chromium used by the console's browser workflow:

```sh
npm ci
npx playwright install chromium
```

Complete the platform prerequisites below. Source installations then run:

```sh
npm run setup:desktop
npm run doctor:desktop
npm run build
npm start
```

This public source edition includes no precompiled Windows bridge. Run `setup:desktop`, which requires Rust/MSVC. Use `npm.cmd` and `npx.cmd` in PowerShell when execution policy blocks npm scripts. Core setup builds schemas and runs diagnostics, but does not install native, training, or model dependencies.

The desktop doctor checks native dependencies, permissions and visible-window discovery. It does not send input or establish complete live platform qualification. Read its capability notes if a feature is unavailable. Keep the service terminal open. In another terminal in the same directory, run:

```sh
npm run token
npm run open
```

Paste the token into the console and connect. Install and run Ollama with a capable local model before planning a task. Choose an installed model in the console. Windows development tests used `qwen3.6:latest`; model weights are not bundled or downloaded at startup. An unavailable model does not prevent the service or desktop doctor from starting.

`npm stop` shuts down the service and releases ownership. Wait for Runtime stopped. `npm restart` stops the old process and starts a new one in that terminal. Ctrl+C or entering `stop` also works. Use the same `CUR_DATA` as startup. Tasks and the token survive. Reconnect the console after a restart. Inspect interrupted actions and release any still-held input, then use Return control. Reconcile the saved task separately. Return does not replay its interrupted action or prove the app effect. If reconciliation cannot establish completion, submit a new deliberate task.

## Windows

Install Rust and MSVC Windows build tools, then run `npm run setup:desktop` to build the Rust bridge. This public repository contains source, not the historical Windows binary.

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
sudo apt install python3-gi python3-xlib python3-pil gir1.2-atspi-2.0 at-spi2-core xclip wl-clipboard xdg-utils gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-base
```

On Fedora:

```sh
sudo dnf install python3-gobject python3-xlib python3-pillow at-spi2-core xclip wl-clipboard xdg-utils gstreamer1-plugins-base pipewire-gstreamer
```

The adapter uses `/usr/bin/python3` so it can see distribution-installed GI bindings. `CUR_DESKTOP_PYTHON` can select another interpreter with the same packages. Run from a terminal in your logged-in desktop with its session D-Bus environment. A plain SSH shell or a headless server does not supply that session. If Chromium reports missing libraries, install the dependencies it requests or use `npx playwright install-deps chromium` with the required system privileges.

Enable accessibility in the desktop and target app if controls are absent. The implementation uses [AT-SPI editable text](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/method.Accessible.get_editable_text_iface.html) and, on X11, [python-xlib XTEST](https://github.com/python-xlib/python-xlib/blob/master/Xlib/ext/xtest.py). It skips password fields. X11 screenshots require the selected window to be in front and fully on screen.

The launcher detects a calculator, text editor and file manager from fixed installed executables. It supports common GNOME, KDE and Xfce choices. Launch other applications yourself and select their supported windows. Sandboxed apps may expose fewer controls. On Wayland, activation can be refused by the compositor; bring the target forward when needed.

Token copying uses `wl-copy` on Wayland and `xclip` on X11. `npm run token` works without a clipboard helper. The console opener uses `xdg-open`.

### Capture guardian requirements

The repaired Wayland capture worker needs Linux process features in addition to GI, Pillow and GStreamer. Its selected Python interpreter must expose `os.pidfd_open` and `signal.pidfd_send_signal`, both added in Python 3.9. The combined pidfd path requires Linux 5.3 or newer. A container uses its host kernel and must permit these calls. The worker also reads `/proc` process identities and uses libc `prctl` to set and verify child-subreaper ownership and arm the actor's guardian-death signal. If any required feature is unavailable, capture startup fails. It does not fall back to in-process GStreamer. See the [Python pidfd documentation](https://docs.python.org/3/library/os.html#os.pidfd_open), [signal API](https://docs.python.org/3/library/signal.html#signal.pidfd_send_signal), [Linux subreaper API](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html) and [parent-death signal API](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html).

Use distribution Python with the desktop's GI packages. The isolated Linux fault checks used Python 3.11. `CUR_DESKTOP_PYTHON` must select an interpreter with all of these APIs and packages. Presence of a portal or a successful permission dialog alone does not establish a working stream; the session also needs PipeWire and a working policy manager.

The parent retains Portal session and input authority. A separate actor opens the stream, and a private guardian reports whether its descendants settled. A new graceful close requires both the reply and a completed guardian outcome. Missing settlement evidence remains failure. Deadline expiry has a separate bounded cleanup allowance. The [independent 51-test review](../docs/open-source/EVIDENCE.md) uses real isolated processes with explicit capture and Portal doubles. It does not establish live PipeWire pixels or physical input release. The separately reviewed live 20-check run proves actual consent, timestamped pixels and GTK effects at the earlier 299-file checkpoint in the private supported profile below. It is separate from these fault tests. The source is [capture_worker.py](native/unix/capture_worker.py) and [portal.py](native/unix/portal.py).

### Wayland permission and current limits

Service startup never opens a permission dialog. In Desktop, click **Allow desktop input and capture** to request the service's portal session. **Cancel permission request** closes the pending request. Pause active work before changing permission. The system dialog decides which devices and monitor it grants. Closing that session or losing the portal/backend owner removes its input and capture capabilities and invalidates old observations.

For an explicit diagnostic prompt, run:

```sh
npx tsx scripts/desktop.ts consent
```

The diagnostic closes its own temporary session on exit. It does not grant the already running service a session. `npm run doctor:desktop` reports capabilities without prompting.

The current global coordinate path requires one selected monitor, a focused fullscreen target, matching monitor and captured pixel dimensions, and scale 1. Floating windows, ambiguous stream mappings and fractional scaling remain denied. This is an implementation limit even when a portal is installed and consent succeeds.

Static PipeWire streams can return a cached image for display. That image keeps its original source timestamp and sequence. It cannot authorize current pixel input or visual completion. Global preflight needs a genuinely new frame after the prior observation, so a static desktop can reject coordinate input while accessible controls remain usable. See [evaluation/linux-portal-profile.md](evaluation/linux-portal-profile.md) for the exact tested profile, source references, failures and reproduction.

## Earlier controlled Wayland check

The [actual live20 receipt](../docs/open-source/EVIDENCE.md) binds the earlier 299-file source. The [independent saved-state review](../docs/open-source/EVIDENCE.md) checks all 20 original assertions, the four runtime-side input digests and UID 1000, PNG pixels, GStreamer PTS/cache behavior, three exact non-dispatch refusals and separate GTK callbacks. The saved profile is Debian 12, Mutter 43.8, GNOME portal 43.1 and one fullscreen 1280x900 virtual monitor at scale 1. It does not establish physical displays, fractional scales, other backends or Linux model quality.

The outside private session disables only its Bluetooth monitor's unavailable logind dependency and verifies exact PipeWire/WirePlumber readiness before starting the compositor. The original default policy and all original examiner assertions/deadlines remain. Earlier 30-second transition, startup, Windows-bind transport and Docker copy failures remain saved. The final intentional stop of exact PipeWire PID 81 precedes the manager watchdog's loss record and the real Session.Closed signal.

The exact owned container stopped within its bound with exit 137. That is bounded forced container settlement, not graceful finalization. Its wrapper has no cleanup errors. The separate parent-EOF examiner worker exited 0; GTK callbacks independently matched key/pointer release.

## Historical controlled Linux checks

The earlier checked environment was Debian 12 in a disposable Docker container, with system Python 3.11, Node 24.21, AT-SPI2, GTK3, Openbox, Xvfb and Weston. These were real Linux GUI processes, not mocked native APIs. The display servers were virtual, so this does not establish physical multi-monitor or hardware-specific behavior.

Add the test tools on a disposable Debian environment:

```sh
sudo apt install gir1.2-gtk-3.0 xvfb openbox dbus-x11 weston galculator
npm run build
sh evaluation/linux-desktop-run.sh
sh evaluation/linux-wayland-run.sh
node --import tsx evaluation/service-usability.ts
```

The scripts create an owned GTK editor and independent display sessions. They verify actual text and button effects, lease revocation, cleanup, shared HTTP task review, the console and its narrow layout. Reports go to `evidence/linux-*.json`. The lifecycle check starts its own service/store and browser, then exercises token reveal, shutdown, restart, reconnect and a browser fixture task.

The historical portal development report is `evidence/linux-portal-v1/mutter16/native-report-attempt16.json`. Its 20 checks use Mutter 43.8, GNOME portal 43.1, XDG frontend 1.16 and PipeWire 0.3.65, with real consent and independent GTK callback effects. The compositor is headless on a virtual display. It does not certify generic Wayland window positioning, mixed monitor scale, physical Linux hardware or other portal backends. `tests/portal_test.py` contains protocol/fault doubles and must not be counted as native effects.

Unix observations currently refresh the full selected target. No absence of an AT-SPI event is used to authorize cached controls or pixels. Windows event and selective observation work has its own qualification.

`npm test` also covers the common contracts and Python worker checks. The training-cancellation test uses an owned deterministic child process and does not require PyTorch. Actual model training requires the optional environment from `scripts/setup-training.sh` or `scripts/setup-training.ps1`. The older desktop-only Linux environment did not install those dependencies; its original limitation remains recorded in `evidence/linux-regressions.json`. Service training selects `.venv` when present, otherwise `python` on Windows or `python3` elsewhere. `CUR_TRAINING_PYTHON` overrides that interpreter independently of the desktop worker.
