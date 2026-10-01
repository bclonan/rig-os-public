# Setup, startup and operation

Run all commands from the `computer-use-runtime` directory. This guide covers core installation, native desktop setup, local models, daily operation and recovery. The [repair status](REPAIR_STATUS.md) records the repaired source and new verification results from October 1 UTC.

The service runs on the computer whose desktop it controls. Use that user's unlocked desktop session. A browser on another computer would still operate the service's computer.

## Start after installation on Windows

Open Command Prompt:

```cmd
cd /d C:\path\to\rig-os\computer-use-runtime
npm start
```

Keep the terminal open. Startup prints `Computer use runtime is ready.`, `Open: http://127.0.0.1:4317` and the token file path. A custom store or port changes the printed address and path. Enter `open` and press Enter to open the console. Enter `copy` to copy the token, or `token` to display it. Paste the value into Local service token and click Connect.

If it says the runtime is already running, startup returns to the shell prompt. Use the npm commands below at that prompt. Bare `open` or `copy` only works inside the original service terminal.

In another Command Prompt in the same directory:

```cmd
npm run status
npm run open
npm run token -- --copy
```

The same commands work in PowerShell with `npm.cmd` in place of `npm`. For example:

```powershell
Set-Location -LiteralPath 'C:\path\to\rig-os\computer-use-runtime'
npm.cmd start
```

Using `npm.cmd` avoids a PowerShell execution-policy error from `npm.ps1`. It does not change the machine's execution policy.

## First-time core installation

Install [Node.js](https://nodejs.org/en/download) 24.17 or newer within the 24.x line, including npm. Node 25 and 26 are outside this package's declared range. Reopen the terminal after installing tools so it receives the updated PATH.

Check the tools:

```sh
node --version
npm --version
```

For source installation, use the existing checkout and enter `computer-use-runtime`. For archive installation, extract the whole ZIP into a new directory and enter the extracted directory containing `package.json`, `src`, `scripts` and `models`. Do not copy only the executable. Choose a directory writable by your ordinary user.

On Windows, from Command Prompt:

```cmd
cd /d C:\path\to\computer-use-runtime
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1
```

On macOS or Linux:

```sh
cd /path/to/computer-use-runtime
sh scripts/setup.sh
```

Setup installs the locked npm dependencies, downloads Playwright Chromium, builds the console and TypeScript library, generates schemas and runs general diagnostics. Running it again repeats these steps. It does not start the service, install native desktop or training dependencies, or download model weights. The first installation needs network access and disk space for these dependencies.

On Linux, Chromium may report missing system libraries. Follow that error or run `npx playwright install-deps chromium` with the system privileges it needs, then repeat setup.

The equivalent manual core steps are:

```sh
npm ci
npx playwright install chromium
npm run build
npm run cli -- schemas
npm run doctor
```

Use `npm.cmd` and `npx.cmd` for these manual steps in PowerShell if script execution is blocked. General doctor writes `evidence/doctor.json` and reports optional components. Its successful exit alone does not mean a native backend, model or training environment is ready.

## Enable native desktop control

Core setup is sufficient for the managed browser fixture. Native desktop tasks need the host's bridge and permissions. Full package lists and platform limits are in [PLATFORMS.md](../PLATFORMS.md).

On Windows source checkouts, install [Rust through rustup](https://rust-lang.org/tools/install/) and the [Visual Studio C++ build tools](https://learn.microsoft.com/en-us/cpp/build/vscpp-step-0-installation?view=msvc-170), including the Desktop development with C++ workload and Windows SDK. Then run:

```cmd
npm run setup:desktop
npm run doctor:desktop
```

`setup:desktop` builds the Rust bridge. This public source edition contains no precompiled Windows bridge, so run the build before native desktop use. Run target apps and the service as the same ordinary user. The bridge does not control UAC or elevated windows.

On macOS 14 or newer, install [Python](https://www.python.org/downloads/) 3.10 or newer as `python3`, then run:

```sh
npm run setup:desktop
```

This creates `.venv-desktop` and installs the pinned PyObjC packages. Grant Accessibility access in System Settings to the terminal or Python application identified by macOS. Grant Screen Recording access for screenshots. Reopen that terminal after changing permissions, then run `npm run doctor:desktop`. The Mac adapter is implemented, but no native Mac execution has been verified in this project.

On Linux, install the distribution packages listed in [PLATFORMS.md](../PLATFORMS.md#linux), then run `npm run setup:desktop` and `npm run doctor:desktop` from a terminal in your logged-in desktop session. A plain SSH session does not supply the required desktop D-Bus environment. The Linux worker normally uses `/usr/bin/python3` with system GI packages, separately from the training virtual environment.

On Wayland, use Allow desktop input and capture in the console to request the service's portal session. The desktop doctor does not request consent or send input. A diagnostic `npx tsx scripts/desktop.ts consent` uses its own temporary session and cannot grant the running service permission. Global input currently requires the narrow scale-1, one-monitor, fullscreen profile documented in PLATFORMS.md. Accessible controls can work without global input consent.

If native setup fails, the service can still offer the browser fixture and show the desktop error. Missing Playwright Chromium prevents service startup.

## Install a local model for desktop planning

Install [Ollama](https://docs.ollama.com/quickstart). Its Windows application normally keeps a local server running on `127.0.0.1:11434`. On other hosts, start `ollama serve` in a separate terminal if a server is not already running. Do not start a second server on the same port.

Inspect installed models and download one explicitly if needed:

```sh
ollama ls
ollama pull qwen3.6:latest
```

These are [Ollama CLI commands](https://docs.ollama.com/cli). The [Qwen 3.6 model](https://ollama.com/library/qwen3.6) used in Windows development occupied about 22.6 GB on the tested host, which had 64 GB RAM. This is a tested configuration, not a minimum hardware specification. The first request can take longer while the model loads. Smaller models made planning errors in the recorded development checks.

The console lists installed models from the default local Ollama endpoint. Select one before planning. Startup never downloads a model. Missing Ollama does not block the service or the structured browser fixture. Free-form desktop planning and model-backed artifact generation need a working local model.

There is no service environment variable that switches the console to an arbitrary OpenAI-compatible endpoint. `CUR_PLANNER` and `CUR_CREATIVE` are overrides in evaluation scripts. The generic local endpoint provider is a library implementation and requires explicit code configuration. It is not a console setup option.

## Daily startup and shutdown

```sh
npm start -- --open
```

This starts the service and opens its console. If the same store already has a verified running coordinator, startup prints the existing URL instead of starting a second one. `npm start -- --show-token` explicitly prints a token on a new startup. Use `npm run token` to retrieve it from an already running service.

| Action | Command |
|---|---|
| Inspect selected service | `npm run status` |
| Open running console | `npm run open` |
| Display token | `npm run token` |
| Copy token | `npm run token -- --copy` |
| Shut down | `npm stop` |
| Shut down and start in this terminal | `npm restart` |

In the service terminal, `open`, `token`, `copy`, `status` and `stop` also work. Ctrl+C or Shut down runtime in the console requests shutdown. Wait for Runtime stopped before starting again. Shutdown pauses queued and active tasks, stops training, closes workers and releases store ownership. Closing the browser tab alone does not stop the service.

The default token is `.data/service/service.token`. The default store also writes `.data/service.token` for existing clients. A custom store has its own `service.token`. Run the token command with the same store setting as startup. Token display works while stopped once a token has been created. Tokens never belong in browser URLs, source control or shared logs.

The console keeps the token in this tab's session storage. After restarting, click Reconnect. Disconnect clears it. Saved tasks, recordings, artifacts, skill versions and model registrations remain in the store.

Paused tasks need an explicit Resume. Inspect the target app before reconciling an interrupted or uncertain action. The runtime does not replay it automatically. If input cleanup failed, inspect the desktop and release any held key or mouse button yourself, then use Return control. Return retries cleanup; it does not verify the earlier app effect. Describe the remaining work or create a new deliberate task when completion cannot be established.

Older saved nested-skill tasks may lack the new per-invocation budget counters. The repaired runtime refuses to invent those counters on resume. Inspect and reconcile their prior effects, then submit a separate task for remaining work. Existing recordings and pinned skill versions remain stored.

## Choose a store or port

The default service store is `.data/service`. `CUR_DATA` selects another directory. Relative paths resolve from the runtime directory. `CUR_PORT` selects a loopback port; otherwise lifecycle commands use that store's saved port, or 4317 for a new store.

PowerShell example for a separate instance:

```powershell
$env:CUR_DATA = '.data/my-assistant'
$env:CUR_PORT = '4318'
npm.cmd start -- --open
```

In its second terminal, repeat the same store settings before running lifecycle commands:

```powershell
$env:CUR_DATA = '.data/my-assistant'
$env:CUR_PORT = '4318'
npm.cmd run token -- --copy
npm.cmd run status
npm.cmd stop
Remove-Item Env:CUR_DATA, Env:CUR_PORT -ErrorAction SilentlyContinue
```

In Command Prompt use `set CUR_DATA=.data/my-assistant` and `set CUR_PORT=4318`. Clear them with `set CUR_DATA=` and `set CUR_PORT=`. On Unix use `export CUR_DATA=.data/my-assistant` and `export CUR_PORT=4318`; clear them with `unset CUR_DATA CUR_PORT` after stopping. Clear both in the original terminal too if you later return to the default store.

Each store needs its own port, token and coordinator. Do not run offline CLI commands against a store while its service owns it. Stop that service or use a separate store. A live lock is not a file to delete. Dead-process ownership recovers at startup. If an older coordinator has no shutdown endpoint or does not respond, stop it in its own terminal with Ctrl+C. A conflicting unrelated process should keep its port; choose another port for this runtime.

## Run the first task

Connect the console. In Desktop, choose This computer for reviewed app navigation or One window for an explicitly selected open app. Start with a blank disposable app state. Enter a goal such as `In Calculator, calculate 37 times 14 using the buttons`, select the local model, and click Plan desktop task.

Review the proposed action and screenshot. Approve this action sends only that proposal. If the app changes, approval becomes invalid and the runtime asks for another review. Continue with this instruction can correct the plan. Pause task, Cancel task and Take over interrupt work. Return control releases manual takeover after cleanup.

The launcher has a fixed list of apps per OS. Open other supported apps yourself and select their windows. The bridge excludes terminal and known credential or security app processes. For screenshots, enable Send screenshots to this local model only when the selected model supports vision. The normal service uses native capture; Oculix research setup is separate.

Inspect the actual app result before clicking Confirm task complete. Your confirmation is recorded separately from objective verification. Free-form goals do not all have independent automatic verifiers. Saving, sending, deleting and clipboard operations still require action review.

For the browser learning demonstration, open Runs, keep Structured form contract, submit three different display names and Record run after each successful run. In Skills, compile the selected recordings, then test and publish the candidate. Learning manages training candidates and qualified activation. This fixture works without Ollama and does not establish general desktop learning.

## Optional training and qualified activation

Training is separate from Ollama. It uses this project's Python learner and ONNX controller. Install Python, then set up the training environment:

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-training.ps1
```

On Unix:

```sh
sh scripts/setup-training.sh
```

These scripts create `.venv` and install `learner/requirements.txt`. `CUR_TRAINING_PYTHON` can select another interpreter. It does not change the Unix native worker's Python. General diagnostics report the selected interpreter and missing packages.

Use Train candidate or Train from recorded experience in Learning. Training produces candidates. A training job's success does not qualify or activate a model. Do not point `CUR_MODEL_DIR` into sealed seed directories. Failed and partial audits remain preserved.

The selected release V4 models need local qualification before installation and explicit activation. [ADR 0006](adr/0006-training-origin-and-deployment-qualification.md) explains why original training source and current deployment qualification stay separate. Preparation checks the public origin before rollout; historical Python files are read and hashed, never executed. A copied key or an old successful result cannot qualify changed source. The [README qualification instructions](../README.md#read-owned-model-advice) include preparation, the approximately 50-minute exposed-case audit, installation, activation and rollback. Keep the qualification directory and private evaluator key. The shipped archive excludes that private key. Replaying exposed cases does not prove performance on unseen tasks.

## Offline CLI and client use

Recording, compilation, import, export, activation and rollback commands acquire an exclusive store and start the managed browser. They require Chromium even when the operation looks like file inspection. Use a disposable separate store:

```powershell
$env:CUR_DATA = '.data/recording'
npm.cmd run record -- 'Alder 101' 'Birch 202' 'Cedar 303'
npm.cmd run compile
npm.cmd run cli -- export form.compiled evidence/compiled-export.json
npm.cmd run cli -- dataset-export evidence/dataset-bundle.json
Remove-Item Env:CUR_DATA
```

The [README](../README.md#record-compile-inspect-and-import) describes quarantine, publication, bundle migration and dataset import. An imported draft cannot execute as an ordinary published task.

For SDK and MCP clients, set the endpoint and the token file for the running store:

```powershell
$env:CUR_URL = 'http://127.0.0.1:4317'
$env:CUR_TOKEN_FILE = '.data/service/service.token'
npx.cmd tsx src/service/mcp.ts
```

This launches the MCP stdio process; your MCP host normally launches it with this command and environment. Set an absolute token file path if the host uses another working directory. The host must not log the credential. Custom ports need the matching `CUR_URL`. The [README client examples](../README.md) document TypeScript, Python and request headers. `CUR_URL` configures clients, not the service's listening address.

## Backup, restore and update

Stop the selected service and wait for ownership release before copying its store. Back up the whole directory, including SQLite, journals, artifact files and token. Also preserve any separate model output, qualification directory with private key, and exported skill or dataset bundles. Storage is not encrypted; use a protected backup location.

For the default service store, this PowerShell example makes a new dated backup without removing an earlier one:

```powershell
npm.cmd stop
$runtimeBackup = Join-Path $env:USERPROFILE ('Documents\rig-os-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $runtimeBackup | Out-Null
Copy-Item -LiteralPath '.data' -Destination (Join-Path $runtimeBackup 'data') -Recurse
Copy-Item -LiteralPath 'models' -Destination (Join-Path $runtimeBackup 'models') -Recurse
```

For `CUR_DATA` outside `.data`, copy that actual directory too. The example assumes the default layout. Inspect the backup before discarding anything. Artifact retention has explicit preview, confirmation and apply operations; it does not automatically delete old data in the background.

To restore, copy a stopped backup's whole service folder to a new sibling store directory. Do not merge database files into a live store. Restore model and qualification files to the original locations recorded by model registration before starting the restored service. Keep it stopped while restoring those files. There is no supported command to rebind an existing registration to another model path, and editing the database is not a restoration procedure.

For example, copying `data/service` from this backup to `.data/restored-service` lets you start with `$env:CUR_DATA='.data/restored-service'` once its registered files are available at their original locations. Use that store's token and inspect saved tasks before reconciliation. If you cannot retain those model and qualification paths, keep the backup intact. Use a fresh stopped store and run a fresh trusted local qualification, then install and explicitly activate its models using the documented procedure. Moving a qualification directory can invalidate its absolute path bindings even when the model bytes match. That fresh store does not automatically recover the old tasks or recordings.

For a source update, stop and back up first. Preserve local changes when obtaining the new source. From the updated runtime directory, run core setup again. Rebuild the Windows native bridge when its source changed, or repeat the host's native setup when dependencies changed. Run `npm run doctor`, `npm run doctor:desktop` and `npm run check`, then `npm start`. Check login and one disposable task before removing the backup or previous version. An update does not load new code into an already running process.

## Ports and local access

The service listens only on `127.0.0.1`, normally port 4317. Ollama normally uses local port 11434. Ordinary local use needs no public firewall rule, HTTPS certificate or certificate-trust change. The token, host and origin checks still apply to API requests.

Public hosting and direct remote desktop access are not configured by this project. Do not change the binding to expose it to a network as part of setup. If you deliberately add an authenticated tunnel, its origin, authentication and desktop permissions need their own validation. The existing local qualification does not verify that deployment.

## Troubleshooting

| Symptom | Next step |
|---|---|
| `npm` cannot find `package.json` | Enter `computer-use-runtime`, or the extracted package directory containing `package.json`. |
| `npm.ps1` cannot run | Use `npm.cmd` and `npx.cmd` in PowerShell. |
| Unsupported Node version | Install Node 24.17 or newer within 24.x and reopen the terminal. |
| Missing `tsx` or dependencies | Run core setup or `npm ci` in the package directory. |
| Playwright executable or Chromium library missing | Run `npx playwright install chromium`; on Linux install the reported system libraries. |
| Another coordinator owns this store | Use `npm run status` with the same `CUR_DATA`, then authenticated `npm stop` or its terminal's Ctrl+C. Do not delete its live lock. |
| Port already in use | Select a free `CUR_PORT` for this store. Do not kill the unrelated owner. |
| Missing token file | Start the selected store once. Ensure token and startup commands use the same `CUR_DATA`. A custom store does not inherit a sibling store's token. |
| Console or client receives 401 | Retrieve that store's token again and reconnect. Check `CUR_URL` and `CUR_TOKEN_FILE` in clients. |
| Browser refresh shows disconnected service | Run `npm start`, then Reconnect. Disconnect and enter the selected store's token if it changed. |
| Desktop backend unavailable | Run `doctor:desktop`, install the platform dependencies and follow PLATFORMS.md permission steps. |
| App cannot focus or accept input | Bring it forward, use an unlocked ordinary-user desktop, and check its supported controls. UAC and elevated windows are unsupported. |
| No installed local model or planner timeout | Check `ollama ls`, its local server and model selection. Allow initial loading, then retry planning deliberately. There is no cloud fallback. |
| Screenshot or Wayland coordinate input denied | Check native permissions and the tested portal geometry. Cached static frames cannot authorize fresh coordinate input. |
| Training reports missing PyTorch or ONNX packages | Run the training setup script and check `CUR_TRAINING_PYTHON`. |
| Candidate cannot activate | Preserve the failed report. Qualification and the exact audit key/model bindings are required; job completion alone is insufficient. |
| Task interrupted or input cleanup failed | Inspect the app, release held input, Return control and reconcile. Do not assume the action succeeded or replay it automatically. |

For development checks use `npm run check`. `npm run verify:audit` validates saved audit integrity without rerunning episodes. `npm run evaluate` refuses to overwrite a sealed audit. Native evaluation programs can change apps, files or display settings. Read their ownership and setup requirements before running them; older app-name-only checks must not attach to unrelated open documents. [VERIFICATION.md](VERIFICATION.md) separates tests, native evidence and remaining gaps.

`npm run dev` is a Vite front-end development server. It has no API proxy, and the console requests its own origin. To operate the full assistant, build and use `npm start`. `--headed` on startup shows the managed Chromium fixture; it does not enable native desktop support.

## Release and verification status

Detailed repository evidence links refer to checkout-local records. The portable ZIP excludes raw completion and root review records. Those private records are not required to follow its setup and operating instructions.

The focused provenance repair has 300 maintained files, SHA256 `31667d67fa52f874bc6cdcbdafc88b33a10865ef741217513a495bbfd4248700`. The source is frozen for qualification. The [current quality check](../../docs/open-source/EVIDENCE.md) passed all eight commands, including 327 TypeScript tests and 87 Python cases with 18 Windows platform skips. The earlier 300-file V4 qualification and explicit seed-17 activation passed. [The primary receipt](../../docs/open-source/EVIDENCE.md) records all three command exits as zero and settled cleanup. [Independent metric review](../../docs/open-source/EVIDENCE.md) and [whole-current review](../../docs/open-source/EVIDENCE.md) verify all 2,100 tasks, 300 head cases, exact selected weights, current source and signed finalization. [A separate public-operation supplement](../../docs/open-source/EVIDENCE.md) completed one browser task with two bound acknowledgments and an independently read result, then rolled back to `fixed`. These are exposed-case source requalification and disposable-Store checks. They do not train new weights, activate the user's Store or establish unseen-task or native learning. Source installation remains the earlier 299-file execution. The completed 299-file V4 replay passed browser metrics but failed activation on original trainer provenance. [REPAIR_STATUS.md](REPAIR_STATUS.md) retains both outcomes.

The last [saved read-only service check](../../docs/open-source/EVIDENCE.md) reported stopped at 04:09 UTC on October 1. Run `npm run status` to check it again. `npm start` loads the repaired code into the selected store.

The historical tested archive is `release/computer-use-runtime-0.1.0.zip`, SHA256 `481e25e5b16214a945f3d4dda55eaa384534edbf4e2e261b8fe8461c3ffc985b`. Its exact bytes passed two setup runs and subsequent checks outside Git. It retains its earlier documentation snapshot. This updated workspace guide is a later documentation change and is not claimed to be inside that ZIP. Rebuilding a package changes the archive and requires a new installation check.

The old archive and the frozen 61/63 completion result bind to fingerprint `7dc71f475353cd92f66d7c98feecfadf1c94665be11d93162872abdb2233af6a` across 273 files. They remain unchanged and do not certify the repairs. New packages use unique source-bound filenames and require a new exact-archive installation check. Native Mac execution, physical mixed-DPI qualification, real external host integration and general native learning remain open. The [completion checklist](COMPLETION_CHECKLIST.md), [capability report](../CAPABILITIES.md) and [verification record](VERIFICATION.md) retain the historical evidence and failed attempts.
