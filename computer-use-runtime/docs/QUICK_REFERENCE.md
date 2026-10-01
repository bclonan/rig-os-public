# Quick reference

## Provider repair, October 1, 2026

The later provider repair adds one to four selected models, ordered fallback, parallel proposals and explicit remote consent. Read [provider instructions](../docs/PROVIDERS.md) for setup and limits. The [current public verification record](../../docs/open-source/VERIFICATION.md) reports the source-bound quality checks. Its Node check passed 360 tests. The independent provider review passed 32 focused tests. The [curated development check](../../docs/open-source/PROVIDER_REPAIR_CHECKS.json) records an owned Windows Paint run with two setup clicks and 88 drawing segments, all 90 acknowledged, followed by a changed canvas and human inspection. The task remains `needs_review`; the separate model opinion is uncalibrated. Claude has no live execution evidence, and Unix CLI cleanup has no crash guardian.

The 273-, 299- and 300-file reports below describe their original source. The `31667d67` checkpoint and its selected-case V4 qualification do not qualify the later provider or public source. No historical report, model, acceptance row or frozen contract changed. Native Mac, physical mixed-DPI, real external benchmark integration and general native learning remain open.

Run commands from `computer-use-runtime` with Node 24.17 or later in the 24.x line. [Setup, startup and operation](RUNNING.md) has the full instructions, including native permissions, local models, backup, restore and troubleshooting.

```sh
sh scripts/setup.sh
npm start
```

The setup command above is for macOS and Linux. On Windows run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1` instead. Once configured, daily startup is just `npm start`. In PowerShell use `npm.cmd` and `npx.cmd` if execution policy blocks the npm scripts.

Open `http://127.0.0.1:4317`. In another terminal run `npm run token`, then paste that value into Local service token. `npm run token -- --copy` uses the host clipboard. Keep the service terminal open. `npm stop`, Ctrl+C or the console shutdown button preserve tasks and release workers. Wait for Runtime stopped. `npm restart` starts again with the same store and token. Interrupted actions need inspection and reconciliation.

For desktop use, install the host's native prerequisites, then run `npm run setup:desktop` and `npm run doctor:desktop`. This public source edition has no precompiled Windows bridge. Install an Ollama model separately. [PLATFORMS.md](../PLATFORMS.md) lists packages and permissions. Each desktop action needs review. Human-confirmed completion stays separate from verified success. The structured browser fixture needs neither Ollama nor a native backend.

`npm run dev` starts only Vite with no API proxy. Use `npm run build` and `npm start` for the working console and service. General doctor reports optional components without treating every missing component as a fatal installation error.

For the fixture learning journey, open Runs, submit three different display names and Record run after each succeeds. Open Skills, select the recordings, compile, then test and publish. Learning offers candidate training, audited model activation, rollback and saved audit integrity verification. Corrections remove a recording from positive compilation.

Use the repaired checkout or a replacement archive containing the public origin bundle. The unchanged historical ZIP lacks that bundle. For those selected V4 models, run `npx tsx scripts/requalify-learning.ts prepare .data/owned-qualification/learning-followup-v4`, then `npx tsx evaluation/learning-followup-v4.ts audit .data/owned-qualification/learning-followup-v4`. After a passing local audit, stop the service and run `npx tsx scripts/requalify-learning.ts install .data/owned-qualification/learning-followup-v4 .data/service`. Installation only registers the models. Explicit activation uses `npx tsx scripts/requalify-learning.ts activate .data/owned-qualification/learning-followup-v4 .data/service 17`. Keep that qualification directory and its private key. The audit replays exposed cases without training or changing the selected models. Allow about 50 minutes on the tested host. See [README](../README.md#read-owned-model-advice) for failure handling and rollback. [ADR 0006](adr/0006-training-origin-and-deployment-qualification.md) separates original training provenance from current deployment qualification. Historical Python files are read and hashed, never executed.

## Where changes belong

| Change | Location |
|---|---|
| API schemas and adapter interfaces | `src/contracts` |
| Task order, cancellation, recovery, policy | `src/runtime` |
| SQLite and artifacts | `src/storage` |
| Skill validation, publication, version rollback | `src/skills` |
| Native operations and app catalog | `src/adapters`, `native/src`, `native/unix` |
| Desktop planning and review | `src/assistant` |
| Recording, compilation, training and promotion | `src/recorder`, `src/compiler`, `src/learner`, `learner` |
| HTTP, CLI startup and MCP | `src/service`, `src/cli.ts` |
| Console workflows | `console/App.vue`, `console/DesktopWorkspace.vue` |
| Regression checks and live journeys | `tests`, `evaluation` |

## Verification commands

`npm run check` is the development quality gate. The other commands below create separate evaluation artifacts. Read their setup and ownership rules first. Native evaluations can change desktop apps or display settings; app-name-only historical checks must not attach to unrelated documents.

```sh
npm run check
npx tsx --test tests/review-regressions.test.ts tests/boundaries.test.ts tests/store-recovery.test.ts
npx tsx evaluation/review-console.ts
npx tsx evaluation/service-usability.ts
npx tsx evaluation/verify-audit.ts
python scripts/clean-install.py
```

On Unix use `python3` for scripts unless a Python environment is active. Core process cancellation uses a real test child and does not require PyTorch. Real training needs `learner/requirements.txt`. Optional training setup is `scripts/setup-training.ps1` on Windows or `sh scripts/setup-training.sh` on Unix. Set `CUR_REVIEW_TRAINING=1` to include both real training buttons in the console evaluation. Frozen `npm run evaluate` intentionally refuses to overwrite a sealed audit.

## Configuration

| Name | Purpose |
|---|---|
| `CUR_DATA` | Private store directory, default `.data/service` for the service |
| `CUR_PORT` | Loopback port, default 4317 or the store's saved port |
| `CUR_URL`, `CUR_TOKEN_FILE` | Client/MCP endpoint and credential file |
| `CUR_DESKTOP_PYTHON` | Python interpreter for Unix native worker |
| `CUR_TRAINING_PYTHON` | Python interpreter for training jobs |
| `CUR_MODEL_DIR`, `CUR_DATASET_BUNDLE` | Candidate training output and optional portable recordings |
| `CUR_PLANNER` | Planner override used by selected native evaluation scripts |
| `CUR_CREATIVE` | Optional model override for drawing evaluation |
| `CUR_NATIVE_EVIDENCE` | Separate output directory for native bridge verification |
| `CUR_DISCOVERY_EVIDENCE` | Separate directory for documentation-discovery evaluation |
| `CUR_REVIEW_REPORT`, `CUR_REVIEW_TRAINING` | Console report path and explicit real-training opt-in |
| `CUR_TEST_MODEL` | Optional model override in recorded-service evaluation |

`CUR_PLANNER` and `CUR_CREATIVE` do not configure the service's model provider. The console discovers models from local Ollama at `127.0.0.1:11434`. Use the same `CUR_DATA` in every lifecycle terminal. Clients need the matching `CUR_URL` and token file, normally `.data/service/service.token`.

The desktop worker also reads OS-owned `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_SESSION_TYPE`, `XDG_SESSION_ID` and `LOCALAPPDATA`. Do not repurpose them. `TEST_STORE` is a subprocess-test setting, not a product option. Public CLI flags are `--open`, `--show-token`, `--headed` for start and `--copy` for token. Evaluation flags include `--attach` for the disposable Windows editor and `--inspect` for stopping the Paint check at its file dialog. `record --headed` is not a supported CLI combination because recording arguments are names.

The desktop planner and Unix key tables restrict supported shortcuts. Normal text fields use native editing keys. The console uses semantic buttons, links and form submission with standard Tab and Enter behavior; it registers no custom keyboard shortcuts. Ctrl+C stops the CLI service. macOS task shortcuts use Command where Windows and Linux use Control.

Use a separate store and port for tests. Never delete a live lock. If startup reports another coordinator, run `npm run status` and use its authenticated stop command. A stale dead-process claim recovers at startup. An uncertain task requires inspection and reconciliation; resume does not replay it. If a native app denies focus or capture, follow its OS permissions in PLATFORMS.md. A missing model or training dependency is a reported failure, not a silent fallback.

Stop the service before backing up its whole store, including artifacts. Preserve external model outputs and qualification keys too. Updates require rebuilding the console and restarting the running service. Keep the backup and the previous package until a startup and task check pass.

The historical September 30 completion audit passed 61 of 63 applicable requirements at the 273-file source. It does not certify the repaired 300-file working tree. Native Mac execution remains blocked and physical mixed-DPI qualification remains FAIL. These updated instructions are later than the unchanged tested ZIP. Use [REPAIR_STATUS.md](REPAIR_STATUS.md) and [VERIFICATION.md](VERIFICATION.md) for the repair checkpoint; [COMPLETION_CHECKLIST.md](COMPLETION_CHECKLIST.md) retains the frozen historical ledger.

The earlier pre-publication 300-file source has fingerprint `31667d67`. Its [eight-command quality check](../../docs/open-source/EVIDENCE.md) passed with 327 TypeScript tests and 87 Python cases, including 18 Windows platform skips. Source installation and the live Linux 20-check profile retain their earlier 299-file identities. The completed 299-file V4 metric pass did not qualify activation. Its failure remains unchanged. The earlier 300-file V4 qualification and explicit seed-17 activation passed. [The primary receipt](../../docs/open-source/EVIDENCE.md) records all three command exits as zero and settled cleanup. [Independent metric review](../../docs/open-source/EVIDENCE.md) and [whole-current review](../../docs/open-source/EVIDENCE.md) verify all 2,100 tasks, 300 head cases, exact selected weights, that 300-file source and signed finalization. [A separate public-operation supplement](../../docs/open-source/EVIDENCE.md) completed one browser task with two bound acknowledgments and an independently read result, then rolled back to `fixed`. These are exposed-case source requalification and disposable-Store checks. They do not train new weights, activate the user's Store or establish unseen-task or native learning.

The [physical-transfer preparation](../../docs/open-source/EVIDENCE.md) has [independent whole-method review](../../docs/open-source/EVIDENCE.md) and remains UNRUN. Live execution still requires its ownership preconditions and explicit root foreground release. Its twelve checks used disposable files only. They do not qualify mixed DPI or permit control of the saved unowned Settings window.
