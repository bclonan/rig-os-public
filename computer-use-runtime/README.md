# Computer use runtime

A standalone local runtime that executes bounded skills, records visual demonstrations, compiles parameterized workflows, and selects skills with an owned trainable controller. It has a headless TypeScript library, authenticated local service, Vue console, Python and TypeScript clients, and native Windows, macOS and Linux adapters.

See [PLATFORMS.md](PLATFORMS.md) for installation, permissions and the tested capability of each OS. Windows and controlled Linux desktop tasks have passed live checks. The macOS implementation follows the public Apple APIs but has not run on a Mac yet.

This public source edition has 300 maintained files. It changes three source/test files to admit an exact portable training-origin derivative and prove that origin admission cannot replace a successful audit terminal. [Portable evidence](../docs/open-source/PORTABLE_EVIDENCE.md) records those changes. Bundled models need fresh local qualification against this public source before activation. New stores use the fixed selector.

The earlier repaired source had fingerprint `31667d67`. Its quality checks and controlled V4 qualification passed. The public edition's [verification record](../docs/open-source/VERIFICATION.md) identifies new checks separately. A frozen family study measured 185 correct effects out of 300 with trained weights, 75 with initialized weights, and 300 with the authored controller. The learned-transfer gate failed. General desktop learning, native Mac execution, and physical mixed-DPI qualification remain unresolved. Read [repair status](docs/REPAIR_STATUS.md) and the [historical completion checklist](docs/COMPLETION_CHECKLIST.md) for the earlier results and their limits.

No Lense or Agent-OS files were changed. Neither application is required.

Read [Setup, startup and operation](docs/RUNNING.md) for the complete Windows, macOS and Linux instructions, including first installation, native dependencies, local models, tokens, shutdown, restart, backup, restore and troubleshooting. Run commands from this directory. `npm run dev` starts the front end alone; use the built console with `npm start` to run the assistant.

## Start after installation

From Command Prompt:

```cmd
cd /d C:\path\to\rig-os\computer-use-runtime
npm start
```

Keep that terminal open. The runtime prints its URL and available commands. Type `open` and press Enter to open the console. Type `token` to display your login token, or `copy` to copy it. Paste into **Local service token** and click **Connect**. Tokens are displayed only when requested, never placed in a browser URL.

If startup reports that the runtime is already running, it returns to the shell prompt. Use `npm run open` and `npm run token -- --copy` at that prompt. Bare `open` and `copy` are commands only in the original running service terminal.

These commands also work in another terminal in the same directory:

| Command                     | What it does                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `npm run token`             | Display the existing login token, even when the service is stopped                        |
| `npm run token -- --copy`   | Copy the token to the clipboard                                                           |
| `npm run open`              | Open the running console in your default browser                                          |
| `npm run status`            | Report whether the selected service is running                                            |
| `npm stop`                  | Pause active and queued tasks, stop training, close browser workers and release the store |
| `npm restart`               | Stop the existing service and start it in this terminal                                   |
| `npm start -- --open`       | Start and open the console                                                                |
| `npm start -- --show-token` | Start and explicitly print the token                                                      |

In the running terminal, enter `stop` or press Ctrl+C for the same shutdown. The console also has **Shut down runtime**. Wait for **Runtime stopped** before restarting. Saved tasks, demonstrations, models and the login token survive shutdown. Paused tasks require an explicit Resume; interrupted or uncertain effects require reconciliation. Closing the browser tab does not stop the service.

If input cleanup fails, the runtime blocks new tasks in that host session. After a restart, inspect the desktop and release any held key or mouse button yourself, then click **Return control**. The runtime retries its cleanup before acknowledging that return. It leaves interrupted tasks unresolved and sends no action automatically. A worker shutdown error does not prove that the OS released input.

The token belongs to the selected data store at `.data/service/service.token`. The default store also maintains `.data/service.token` for existing clients. Custom stores each use their own token file and cannot fall back to another store's sibling token. The console remembers a token in this tab's session storage so a refresh or server restart does not require copying it again. **Disconnect** clears it. The reconnect screen remains available after shutdown; run `npm start` and click **Reconnect**.

If an older version is still running, press Ctrl+C in its terminal once before using the new lifecycle commands. That older process cannot acquire new shutdown routes until it restarts.

## Use the desktop assistant

The console opens on Desktop with **This computer** selected. Enter a goal, choose an installed local model, then click **Plan desktop task**. If installed, `qwen3.6:latest` is the preferred default. The assistant first proposes opening an app or switching to an existing window. Review that action to continue. It can carry a result into another app within the same task.

Choose **One window** to limit a task to an open app and its owned dialogs. Open the app, click **Refresh open apps**, and select it. Planning brings the selected app to the front. Return to the console to review the proposed action and screenshot.

Click **Approve this action** to execute exactly that action. The runtime captures the app again before and after input. A changed app invalidates the approval and triggers a new proposal. Use the instruction box to correct the plan, answer a question, or describe the remaining work. **Pause task**, **Cancel task**, and **Take over** interrupt planning and execution. **Return control** releases manual takeover.

Examples for a blank document or disposable app state:

- In Calculator, calculate 37 times 14 using the buttons.
- In blank Notepad, write a short meeting agenda without saving it.
- Read the selected window and explain what it shows.
- Open Calculator, calculate 23 times 17, then write the result in a new Notepad document. Leave existing documents untouched and do not save.

Every action needs review, including app switches, launches, saves, sends, deletions and clipboard operations. The launcher offers installed apps from a fixed OS-specific list. Windows includes Calculator, Notepad, Paint and File Explorer; macOS includes Calculator, TextEdit, Finder and Preview; Linux detects a calculator, editor and file manager. Open other apps yourself; computer tasks can select their supported windows. A launch may reuse a window or restore documents, so ask for a new document when needed and review the text target.

The bridge excludes terminal, credential, password-manager and known security app processes. It has no shell execution tool. UI review remains necessary, including when a browser is selected. The console reports the detected OS, native setup errors and available capabilities. Wayland can use accessible controls without global input consent. Portal capture and pointer input require explicit OS consent through the console. Cached screenshots are display-only; coordinate actions need a fresh frame. The tested GNOME/Mutter profile and static-stream limits are in [evaluation/linux-portal-profile.md](evaluation/linux-portal-profile.md).

The default planner reads the OS's accessibility controls. Enable **Send screenshots to this local model** for a model that supports vision when the desktop adapter can capture screenshots. Screenshots and window text go to local Ollama and remain in the local task store. This is a new general task planner; it does not use or retrain the frozen fixture controller.

A model's final answer appears as **Review the result**. Check the app and click **Confirm task complete**. That records your confirmation separately from independent verification. The live Calculator and Notepad evaluations use independent Windows control reads, but ordinary free-form tasks do not have an automatic verifier for every possible goal.

An earlier cross-app check calculated `23 x 17 = 391` and wrote the result in a new Notepad document. Its app-name-only evaluator is unsafe to repeat while unrelated Notepad windows are open. The latest computer-scope console check uses a fresh owned editor, three reviewed actions and an independent text read. Confirm task complete records user confirmation separately from objective verification.

API clients can submit `POST /api/desktop/tasks` with `{"scope":"computer","goal":"...","model":"qwen3.6:latest","vision":false}`. Use the service token and the usual idempotency and correlation headers. For one-window tasks, set `scope` to `window` and include `handle` and `pid` from `GET /api/desktop/windows`. The same review endpoint approves one proposal at a time.

Install a local model explicitly before planning. The [Ollama model page](https://ollama.com/library/qwen3.6) lists Qwen 3.6 variants and the install command. Its first request took around two minutes while loading on the tested Windows host. The small 0.8B, 1.7B and 4B models made planning errors in development checks. Desktop control requires an unlocked interactive session and non-elevated apps. It cannot control UAC or guarantee usable controls in every app.

On another Windows machine, first complete core setup and install the native dependencies described in [the operating guide](docs/RUNNING.md#enable-native-desktop-control). For a source checkout, build the bridge, check it, install a capable local model in Ollama, and start the service:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1
npm.cmd run setup:desktop
npm.cmd run doctor:desktop
ollama pull qwen3.6:latest
npm.cmd start
```

The native build requires Rust and MSVC Windows build tools. This public repository contains native worker source and no precompiled Windows bridge. Run `setup:desktop` before native desktop use. Qwen 3.6 used about 22.6 GB of disk on the tested host, which had 64 GB RAM. This is a tested configuration, not a minimum hardware specification. No model download occurs during startup. The structured browser fixture does not require Ollama or a native bridge.

If focus is denied, bring the selected app to the front, then use **Continue with this instruction** to retry planning. If input delivery was interrupted, inspect the app and click **I have inspected the app**. Describe what remains; the runtime will not replay an uncertain action. Computer tasks return to the app list when their selected window closes. One-window tasks need a new task with a fresh selection.

The **Runs** tab retains the isolated browser fixture. Keep **Structured form contract**, enter a display name, then click **Run task**. For the learning demonstration, run and record three different names. **Skills** compiles and tests recordings; **Learning** manages the owned controller. These fixture results do not establish general desktop learning.

## Draw through an approved program

Open a new blank Paint document. In Desktop, choose One window and select that Paint window. Enter the subject, choose a local model, then click Plan a bounded Paint drawing. Planning constructs an ellipse/polyline program and captures the selected canvas. It does not draw or save.

Review the frozen program and segment count, then click Approve drawing program. The runtime draws at most 120 segments within that canvas. Moving or resizing the canvas invalidates the plan. Pause, cancel and takeover use the same coordinator as other desktop tasks.

After stroke execution and cleanup, the task asks for subject review. Choose a local vision model and use Assess canvas with selected local vision model to inspect only the canvas. That assessment is separate from verified input delivery. Check the actual drawing before confirming completion. Confirming records your decision. It does not turn a model's opinion into independent objective verification. Drawing never implies saving, uploading or importing an image.

## Construct a verified artifact

The Artifacts tab accepts a task, pasted input or an explicitly authorized public URL, an output format, handwritten verification criteria and a local model. The console prepares an isolated workspace and a result.json or result.csv destination. The runtime reads only the granted source and writes only the granted destination.

JSON and CSV workflows verify every output row and requested calculation against the source. When verification finds a difference, the runtime attempts a bounded repair and checks the result again. The task history retains failed attempts. Preview and download become available for the exact verified output bytes. A generation response alone cannot mark the task complete.

The historical 273-file source evaluation used qwen3.6:latest for JSON repair, quoted CSV calculation, a public GitHub research read and the live console preview/download flow. Independent review recomputed each output from its source. The default qwen3.5:4b attempt failed and remains recorded. These reports identify their models and remain separate from the owned controller's learning evidence.

## Read owned model advice

For a selected run, Read owned model advice captures current state and reads the pinned qualified controller. It reports predicted state and recovery advice without sending input. A model must pass its frozen followup qualification before its auxiliary heads can appear as available. Advice cannot expand permissions, authorize an action or verify completion. The V3 protected full-head and visual-state evaluation failed, and its results remain unchanged. The original V4 final passed 2,100 task rows and 300 auxiliary-head cases. The historical 273-file `7ae1918f` release replay passed those same exposed cases with separate metric and provenance reviews. Public installation, explicit activation, advice and rollback also passed in a disposable extracted-release Store. This does not establish performance on new cases or activate anything in your service Store.

The 299-file V4 replay completed all 2,100 tasks and 300 head cases. Its browser metrics passed, but activation rejected the selected trainer's original source hash. That failed qualification remains unchanged. The earlier 300-file V4 qualification and explicit seed-17 activation passed. [The primary receipt](../docs/open-source/EVIDENCE.md) records all three command exits as zero and settled cleanup. [Independent metric review](../docs/open-source/EVIDENCE.md) and [whole-current review](../docs/open-source/EVIDENCE.md) verify all 2,100 tasks, 300 head cases, exact selected weights, current source and signed finalization. [A separate public-operation supplement](../docs/open-source/EVIDENCE.md) completed one browser task with two bound acknowledgments and an independently read result, then rolled back to `fixed`. These are exposed-case source requalification and disposable-Store checks. They do not train new weights, activate the user's Store or establish unseen-task or native learning. An older followup audit cannot qualify changed executable source by itself.

The package builder includes the selected V4 models, recorded inputs and a public training-origin bundle. Every new archive needs exact-byte inspection and a separate seven-command installation outside Git, including setup twice. CRC and package checks alone do not prove installation. The checkout repair checklist records each actual release receipt. Raw completion and root-review records are excluded from the portable ZIP. The preserved old ZIP keeps its original source and documentation. Every package excludes the private evaluator key. These commands use the repaired checkout or a replacement archive containing the public origin bundle. The unchanged historical ZIP lacks that bundle. Run from the runtime directory:

```sh
npx tsx scripts/requalify-learning.ts prepare .data/owned-qualification/learning-followup-v4
npx tsx evaluation/learning-followup-v4.ts audit .data/owned-qualification/learning-followup-v4
npm stop
npx tsx scripts/requalify-learning.ts install .data/owned-qualification/learning-followup-v4 .data/service
```

Preparation copies the selected bytes and the hash-bound public origin into a fresh directory. It checks all 22 selected artifacts and six historical source files before rollout. Current executable source stays separate. A missing origin, changed input or wrong protocol rejects before an audit Store is created. See [ADR 0006](docs/adr/0006-training-origin-and-deployment-qualification.md). The audit takes about 50 minutes on the tested host and creates a new local evaluator key and seal. It replays previously exposed cases with unchanged models and thresholds. It does not train, select a new model or establish performance on unseen cases. A failed or partial audit cannot be overwritten. Use a fresh parent directory for a new attempt.

Installation registers qualified candidates without activating them. Explicit activation uses the same source, audit and model checks:

```sh
npx tsx scripts/requalify-learning.ts activate .data/owned-qualification/learning-followup-v4 .data/service 17
npm start
```

Keep the qualification directory in place. Activation and advice recheck its input and model hashes. Stop the service before installing or activating through these commands. Use the Learning tab to roll back to the fixed controller. These models provide advice for the bounded browser workflow. They do not qualify general desktop learning.

If the service already owns this store, `npm start` verifies its authenticated identity and prints the existing URL. It does not create a second coordinator. `CUR_DATA` selects a separate store and `CUR_PORT` selects its port. Subsequent lifecycle commands discover that store's saved port. A port conflict releases the startup lock and reports a readable error. Do not delete a live coordinator lock.

## Fresh installation

Use Node 24.17 or later in the Node 24 line. Training requires Python with `learner/requirements.txt`. Native Windows use requires Rust, the MSVC Windows build tools, and `npm run setup:desktop`. This source edition does not include native binaries.

```powershell
cd computer-use-runtime
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1
npm start
```

```sh
cd computer-use-runtime
sh scripts/setup.sh
npm start
```

Setup installs exact npm dependencies, Chromium, the console, schemas, and diagnostics. It does not start the service or install native, training or model dependencies. Running it again repeats installation without creating another service. On Linux, Chromium may need the operating system libraries reported by Playwright. Complete the separate [native desktop setup](PLATFORMS.md) for the host OS. Linux browser and native desktop execution passed controlled virtual desktop tests on this Windows host. Follow [the full operating guide](docs/RUNNING.md) for optional dependencies and daily use.

The clean-install check creates a new source directory with its own `node_modules`, runs setup twice, runs the tests, and executes an offline fixture. It reuses the installed Node runtime and Chromium download cache. It is not evidence of a fresh Windows VM or an isolated Python installation.

```powershell
python scripts/clean-install.py
npm run doctor
npm test
npm run build
```

## Record, compile, inspect, and import

CLI commands open a headless browser and an exclusive SQLite store. Stop the service before using its store, or choose a separate one as below.

```powershell
$env:CUR_DATA='.data/recording'
npm run record -- 'Alder 101' 'Birch 202' 'Cedar 303'
npm run compile
npm run cli -- export form.compiled evidence/compiled-export.json
npm run cli -- dataset-export evidence/dataset-bundle.json
$env:CUR_DATA='.data/import-review'
npm run cli -- import evidence/compiled-export.json
npm run cli -- dataset-import evidence/dataset-bundle.json
Remove-Item Env:CUR_DATA
```

The compiler needs three successful independent sessions with varying inputs. It aligns common operation/locator sequences, extracts typed parameters, and creates an executable draft. Unexplained variation remains uncertainty. It does not infer causal preconditions from success alone. Drafts and imports cannot execute as ordinary tasks.

In the console, record at least three successful form runs, select those recordings in Skills, compile them, then use **Test candidate and publish if it passes**. The server tests new names and a shifted layout in the resettable form before publishing. The equivalent API is `POST /api/skills/{id}/test`. Publication requires three successful journaled runs of that exact candidate version. The embedded `Runtime.testCandidate` supports the two local fixtures. Broader application validation needs an independent evaluator. Import into a separate store, as above. An imported ID cannot replace an installed skill, and imported data remains quarantined.

Dataset bundles include content hashes and visual artifact bytes. Sharing exports redact private text and original images by default. Import validates every contract, receipt, reference and digest. Imported labels enter quarantine as unknown. Hashes do not establish correctness. The executable SkillCapsule and dataset formats remain version 1. Unknown versions fail closed.

Portable skill packages also have an explicit version 2 bundle format. It retains the original version 1 export bytes, the root skill hash and every transitive dependency hash. The migration only changes the package format. It does not execute or publish the skill.

```powershell
npm run cli -- skill-migrate evidence/compiled-export.json evidence/skill-bundle-v2.json --preview
npm run cli -- skill-migrate evidence/compiled-export.json evidence/skill-bundle-v2.json
npm run cli -- bundle-export form.compiled evidence/current-skill-bundle-v2.json
$env:CUR_DATA='.data/import-review'
npm run cli -- bundle-import evidence/skill-bundle-v2.json
Remove-Item Env:CUR_DATA
```

Preview writes the proposed output file and leaves migration state unchanged. Commit stores immutable original and bundle artifacts with a migration receipt. Import needs matching installed dependencies and a new root skill ID. It adds an import version suffix, clears claimed demonstrations and tests, and creates a new quarantined hash. It preserves the source provenance kind and unresolved uncertainty reasons. Those reasons still block publication, even after successful positive tests. Existing raw version 1 imports still work. Imported packages cannot replace installed skills or authorize ordinary execution.

The authenticated API exposes `POST /api/skills/migrations/preview` and `POST /api/skills/migrate`. Their body is `{source: originalJsonText, from: 1, to: 2}`. `POST /api/skills/bundles/import` accepts `{source: bundleJsonText}`. Send the original JSON as a string to retain its exact UTF8 bytes. `GET /api/skills/{id}/export?schemaVersion=2` exports the inspectable bundle; the default remains a raw version 1 capsule. POST calls require the token, correlation and idempotency headers described above.

Only the handwritten version 1 to version 2 transform is supported. Unknown fields, versions, transforms, corrupt bytes, missing dependencies and changed dependency hashes reject before installation. Publication rechecks the retained dependency manifest and the versions used by new local tests. If a dependency changes, export and import a new candidate under a new ID, then test that candidate. A foreign transform hash is provenance and grants no authority.

## Train and evaluate

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-training.ps1
.venv/Scripts/python.exe learner/train.py
```

```sh
sh scripts/setup-training.sh
.venv/bin/python learner/train.py
```

The scripts create a virtual environment and install pinned Python dependencies. This build trained with the already installed Python environment. A separate Python installation was not downloaded. CPU training and ONNX inference work without a GPU. The installed CUDA build is optional for this experiment.

`npm run train` uses `CUR_TRAINING_PYTHON` if set, otherwise the local `.venv` interpreter, then `python` on Windows or `python3` on Unix. Missing interpreters and failed training exit with an error. Training writes candidate folders after an audit has been sealed, preserving the audited checkpoints. `CUR_MODEL_DIR` can select another output directory. Do not direct candidate training into the audited seed folders.

To include real recorded experience, use **Train from recorded experience** in the console or set `CUR_DATASET_BUNDLE` to an exported dataset bundle before training. The controlled-fixture converter extracts actual before-image crops and prior-action history. Corrections to failure or unknown revoke positive labels. Unknown success labels remain masked. A separate three-seed candidate run incorporated 12 recorded crops, four with verified selection labels and eight masked as failure or unknown. Its ONNX artifacts load, but it has no held-out benefit claim and cannot replace the audited model without a new audit.

The original sealed controller has 10,041 trainable parameters and no frozen pretrained encoder. Each of seeds 17, 41 and 73 executed 550 optimizer updates over 600 synthetic visual training sessions. Validation uses 120 separate sessions. The model has image, history, candidate descriptor, predicate, recovery, and outcome heads. That original selector uses a small set of fixture image features and a fixed context vector. It is not a general history-conditioned desktop policy yet.

The original sealed audit contains 1,200 live browser episodes, 100 per method per seed. It compares trained weights, initialized weights, a competent fixed selector, and the trained controller without compiled skills.

| Method                      | Successes | False success |
| --------------------------- | --------: | ------------: |
| Trained controller          | 300 / 300 |             0 |
| Initialized controller      |  25 / 300 |             0 |
| Fixed selector              | 300 / 300 |             0 |
| Without learned compilation | 300 / 300 |             0 |

The paired 95% interval for improvement over initialized weights is 88.67 to 94.67 percentage points. There is no demonstrated advantage over the fixed selector and no measured efficiency benefit from library growth. The compiled and seed form use the same number of GUI operations. Known navigation made zero generative-model calls during the audit.

Each trained ONNX file is 44,787 bytes. Maximum PyTorch/ONNX output difference was 0.00000573. Original median CPU inference measurements were 0.053 to 0.122 ms. The original RAM field was invalid and recorded zero. A separate repeat corrected the measurement and observed about 821 to 847 MB peak process working set. The original sealed result was preserved, not silently rewritten.

```powershell
npm run evaluate
npm run cli -- activate 17
npm run cli -- rollback
```

`evaluate` refuses to overwrite the existing sealed audit. To run a new full audit, copy the package to a separate directory, preserve the old evidence elsewhere, remove only the copied `evidence/audit-sealed.json` and `evidence/episodes.jsonl`, freeze that copy's `acceptance.json`, and run `npm run evaluate` there. Do not tune against the old audit. Model promotion checks the protocol, result and episode hashes, exact checkpoint hash, seed and export parity. Arbitrary new candidates cannot pass by borrowing an older model's result.

```powershell
npx tsx evaluation/offline.ts
python scripts/offline-training.py
```

Offline checks deny browser networking and Node fetch for execution, and deny Python socket connections for training. They do not disable the user's network adapter. Local file fixtures and cached ONNX models need no cloud credentials.

## Candidate development

```powershell
npx tsx scripts/candidate.ts prepare
npx tsx scripts/candidate.ts check "<path printed by prepare>"
npx tsx scripts/candidate.ts run "<path printed by prepare>"
```

These commands copy the owned learner into a separate candidate directory. Preparation records the current source, configuration, frozen criteria, models, datasets, sealed scientific inputs and installed native worker bytes. Check and run compare that complete inventory before and after each child process. Training writes models, datasets, evidence and caches inside the candidate and uses the configured training interpreter. Failed children and timeouts produce a nonzero command exit and retain a report under `.candidates/.attempts`.

Run also exercises the candidate's ONNX inference and the same runtime. These commands do not activate the result. Review source changes before running a candidate. The guard protects the complete maintained and sealed-input inventory in trusted development. It does not sandbox arbitrary generated code. The historical 273-file guard repair passed separate review and a fresh candidate exercise, including three training checkpoints and a browser task. Promotion still requires a separate independent audit.

## Local language and vision providers

The runtime supports Ollama and a generic OpenAI-compatible loopback endpoint. Provider output passes schema and permission validation. No subscription credentials are scraped, and there is no paid or cloud fallback.

This build used `qwen3:1.7b` for contracts and documentation discovery, `qwen3.5:0.8b` for the form compiler and independent vision assessment, and an already installed `qwen3.6:latest` for a bounded creative plan. The two downloaded smaller models totaled about 2.5 GB, within the recorded 3 GB model bootstrap allowance. Model identities and available metadata are in the evidence. Generation failures remain in the record.

```powershell
ollama pull qwen3:1.7b
ollama pull qwen3.5:0.8b
```

These commands download models and require network access. Compare the resulting digests with `evidence/provider-manifest.json` for reproduction. Models are optional for known skills and owned-model inference. Semantic assessments remain separate from objectively verified task completion.

## Windows and Oculix

```powershell
cargo build --release --manifest-path native/Cargo.toml
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-oculix.ps1
npm run verify:native
npx tsx evaluation/oculix.ts
```

Native tests open or attach to a disposable application. Windows may refuse foreground activation by a background process. Focus the disposable editor and use `npx tsx evaluation/native.ts --attach` when that happens. A failed focus check blocks input. Native smoke tests require a fresh empty editor. Do not attach them to a document with work you want to keep.

Oculix runs through private stdio using a pinned source build and an isolated JDK. This runtime permits its capture tools only. Guarded Rust input binds the selected target and lease before click, type, key, scroll, drag and bounded holds. A direct Oculix backend call has a default 45-second timeout. `WindowsAdapter.observe` caps the entire coherent observation at five seconds, including any preferred Oculix capture. The ordinary service constructs that adapter with native capture; a separately constructed adapter can prefer installed research Oculix. Input always uses the guarded native backend. See [THIRD_PARTY.md](THIRD_PARTY.md).

The Windows bridge binds the machine, session, root window, owned dialog, observation, frame and lease generation. A named Windows mutex excludes competing runtime processes. Global input needs focus. Direct UIA invocation can bind a control without global input focus. Native captures use foreground desktop crops; background/UWP capture may be blank and cannot support visual acceptance. Native typing is limited to 128 UTF-8 bytes per segment.

`evaluation/editor-save.ts` and `calculator.ts` contain the native text-save and arithmetic checks. `evaluation/review-paint.ts` opens a new Paint document, draws a square, enters a unique filename through native input, saves PNG, then checks the actual image bytes and all four edges. Run it with `npx tsx evaluation/review-paint.ts`. The historical 273-file complete-task successor at `evidence/completion/native-tasks-warmed-v1` passed all four categories. It retained the original 90-second Paint limit, three recoveries, long new filename and full image checks. Its persistent read-only helper performs fresh queries on every call. Separate review checked all eight runs, 114 images and saved artifacts. The original failed runs and older `paint.ts`, `save-dialog.ts` and `save-png.ts` remain preserved. Drawing keeps its needs_review status after execution and reconciliation. Independent canvas assessment and user review remain separate from verified stroke delivery.

## Service, SDKs, and integrations

```powershell
$env:CUR_URL='http://127.0.0.1:4317'
$env:CUR_TOKEN_FILE='.data/service/service.token'
npx tsx examples/generic.ts
python examples/agent_os_client.py
npx tsx src/service/mcp.ts
```

The service exposes `/api/capabilities`, `/api/tasks`, `/api/events`, observations and artifacts, task control, recording and corrections, compilation, skill import/export/testing, dataset import/export, training jobs, results, activation and rollback. POST requests require bearer authentication, `X-Correlation-ID`, and `Idempotency-Key`. The TypeScript and Python clients add them. Event sequence numbers support reconnect and replay. Deduplicating requests is not a claim of exactly-once GUI effects.

For Lense, use `examples/lense-client.ts` to submit a contract and consume evidence. If Lense supplies capture and input, implement the injected methods in `src/adapters/bridge.ts` against its real host protocol. For Agent-OS, use `sdk/python/computer_use_runtime.py` and `examples/agent_os_client.py`. Keep the host's own actuator paused while this runtime owns the same desktop. The host can provide transport, but must not create a second execution loop.

Actual Lense and Agent-OS protocols were unavailable here. Their compatibility remains UNVERIFIED. The examples and adapter contracts do not claim that either host was integrated. The benchmark adapter strips evaluator fields and respects structured versus pixel tracks. OSWorld and WindowsAgentArena VM runs are BLOCKED because no benchmark VM and reset endpoint were configured. `npm run benchmark:smoke` reports those limits. No benchmark score is claimed.

## Operation, shutdown, and troubleshooting

- Use Pause to stop at a bounded action boundary. Cancel ends the run. Take over revokes input ownership; Return control explicitly enables later acquisition. These actions do not undo delivered GUI effects.
- Enter `stop`, press Ctrl+C, use `npm stop`, or choose **Shut down runtime** in the console. Shutdown pauses work, waits for training workers to exit, closes event streams and releases the data-store lock. On forced termination, restart marks interrupted runs as requiring reconciliation. An uncertain delivered action is never retried automatically.
- Port 4317 binds to `127.0.0.1` only. Setup opens no firewall rule. Port 11434 is the optional local Ollama endpoint. No certificate is required for loopback use.
- For an explicitly authorized remote client, use an authenticated SSH or VPN tunnel to the loopback service. Keep TLS and client authorization at that boundary. Do not bind a public control port or bypass Host/Origin checks. Remote and second-machine operation remain untested.
- A 401 response usually means the token belongs to a different `CUR_DATA` store. Use `npm run token` with the same store setting. If the coordinator is alive but the service cannot be reached, check its terminal and configured port. Do not delete a live lock or kill an unrelated process.
- Unsupported or ambiguous goals enter an actionable awaiting-input or blocked state. Inspect the error and evidence. Do not replace the requested app with a fixture and call it success.
- If the OS denies focus or a secure desktop appears, stop input. The bridge does not bypass OS protections. Run `npm run doctor:desktop` for local setup errors and see [PLATFORMS.md](PLATFORMS.md) for permissions and Wayland limits. Unconfigured remote desktops remain unavailable.

Back up the whole selected data directory while the service is stopped, including SQLite and the artifact directory. Keep model checkpoints, qualification directories with their private keys and skill bundles with the backup. Tokens and recorded screens are sensitive local data. Storage is not encrypted. Artifact retention supports explicit preview, confirmation and apply operations; it does not automatically delete old data in the background. Keep the directory in the user's protected profile and inspect exports. [Backup, restore and update](docs/RUNNING.md#backup-restore-and-update) includes a copyable backup example and restoration steps.

To update, stop the service, back up the data, install dependencies with `npm ci`, build, run tests and doctor, then restart. Do not promote a new model without matching independent evidence. Keep the previous model and skill version available for rollback.

## Files and evidence

- [ARCHITECTURE.md](ARCHITECTURE.md) defines execution and trust boundaries.
- [SECURITY.md](SECURITY.md) records protections and remaining gaps.
- [CAPABILITIES.md](CAPABILITIES.md) gives scoped gate results.
- [AGENTS.md](AGENTS.md) gives the reading order and required checks.
- [docs/QUICK_REFERENCE.md](docs/QUICK_REFERENCE.md), [docs/CODE_STYLE.md](docs/CODE_STYLE.md) and [docs/adr](docs/adr) document commands, standards and decisions.
- [docs/DEFINITION_OF_DONE.md](docs/DEFINITION_OF_DONE.md), [docs/FEATURE_MATRIX.md](docs/FEATURE_MATRIX.md), [docs/REVIEW_LEDGER.md](docs/REVIEW_LEDGER.md) and [docs/VERIFICATION.md](docs/VERIFICATION.md) record acceptance, coverage and results.
- [docs/HANDOFF.md](docs/HANDOFF.md) contains remaining work and next steps.
- [BUILD_STATE.md](BUILD_STATE.md) and [progress.json](../docs/open-source/EVIDENCE.md) record commands and delivery state.
- `evidence/results.json`, `episodes.jsonl`, and `audit-sealed.json` preserve the original audit.
- `models/{17,41,73}` contains initialized and trained PyTorch and ONNX artifacts.
- `schemas`, `skills`, `sdk`, and `examples` are portable integration material.
- `npm run package` creates the distributable archive and SHA-256 manifest under `release` without tokens, databases, installed packages, or unrelated application data.

Raw native screenshots, desktop window lists, file-dialog inspections and diagnostic stores stay in the local workspace. The archive has controlled browser and portal evidence and an `evidence/qualification-summary.json` file with reported statuses and local raw-file hash references. That summary is not an acceptance certificate. The referenced private raw files are absent from the archive.

Followup model reports and checkpoints in the archive are inspectable evidence. Their activation approval uses a private local evaluator key, which the archive excludes. Moving those files to another directory or machine requires fresh trusted local qualification before activation. The original sealed controller has its separate audit path.
