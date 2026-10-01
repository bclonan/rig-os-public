# rig-os

rig-os is a local computer-use runtime. It runs a browser console and an authenticated service on your computer. A local model proposes desktop actions, you review them, and the runtime checks the target and permissions before sending input. It also records demonstrations, compiles bounded skills, and creates verified JSON or CSV artifacts.

This is an experimental developer tool. Windows and a controlled Linux desktop profile have live execution evidence. macOS has an implementation but still needs live testing. General desktop learning and physical mixed-DPI support remain unqualified.

## What it is useful for

- Review a local assistant's proposed actions in Calculator, an editor, or another supported desktop app.
- Run repeatable workflows with explicit permissions, deadlines, version pins, pause, takeover, and recovery.
- Turn successful recordings into parameterized skills, then test them before publication.
- Generate JSON or CSV from source data and check every requested value before download.
- Study computer-use execution and learned skill selection with saved evidence and negative results.
- Connect an agent through the HTTP API, TypeScript or Python client, or MCP stdio tools.

The repository has no account signup, payments, guest passes, Convex, cloud file uploads, or saved chat/project service. A task is a goal and an execution contract. A run is its saved execution state. A workspace is a granted directory for one artifact task. The [system overview](docs/open-source/SYSTEM_OVERVIEW.md) explains those distinctions.

## Start here

Install Node 24.17 or newer in the 24.x line. Clone this repository, then open a terminal at its root.

On Windows:

```powershell
cd computer-use-runtime
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1
npm.cmd start
```

On macOS or Linux:

```sh
cd computer-use-runtime
sh scripts/setup.sh
npm start
```

Setup installs the locked dependencies, Playwright Chromium, and the built console. It does not install a native desktop bridge, training packages, or Ollama models. The browser fixture works with core setup alone.

Keep the service terminal open. Enter `open` to open the console and `copy` to copy its local service token. Paste the token into Local service token and click Connect. In Runs, keep Structured form contract, enter a display name, and click Run task. This operates the runtime's isolated browser fixture.

Use [the usage guide](docs/open-source/USAGE.md) for desktop tasks, artifact creation, recording, SDKs, and MCP. The [operating guide](computer-use-runtime/docs/RUNNING.md) covers installation, native permissions, models, backup, and recovery. [Platform support](computer-use-runtime/PLATFORMS.md) lists actual OS coverage.

## Explore the architecture

Open [the interactive system map](docs/system-map/index.html). It has zoom, pan, search, ordered journeys, record explanations, and source links for every traced responsibility. It uses no external services.

For a local browser preview, run this from the repository root:

```sh
python -m http.server 4329 --bind 127.0.0.1 --directory docs/system-map
```

Open [the map preview](http://127.0.0.1:4329/). On macOS or Linux, use `python3` if `python` is unavailable. Read [the map guide](docs/system-map/README.md) and [the written trace](docs/system-map/TRACE.md) for details.

## Verification and limits

Run the development gate from `computer-use-runtime`:

```sh
npm run check
```

Fresh checks on the portable public source pass 327 TypeScript tests, type checks, formatting, production build, dependency audit, and Windows Rust checks. The Python suite reported 87 cases with 18 platform skips on Windows. An earlier private-source qualification completed 2,100 browser task cases and 300 prediction cases, then activated a model in a disposable store. Public metadata has been normalized for portability. V4 activation requires a fresh local qualification. These receipts identify their exact source bytes. They do not qualify every desktop app or OS.

The family-transfer study failed its learned-controller gate. Trained weights produced 185 correct effects out of 300, initialized weights 75, and the authored controller 300. Native Mac execution, physical mixed-DPI qualification, external host integration, and general native learning remain open. The historical acceptance ledger records 61 of 63 applicable requirements and an overall failure.

See [the fresh verification report](docs/open-source/VERIFICATION.md) and [portable evidence notes](docs/open-source/PORTABLE_EVIDENCE.md). The [review](docs/system-review/README.md), [repair checklist](docs/system-review/CHECKLIST.md), and [current repair status](computer-use-runtime/docs/REPAIR_STATUS.md) keep the evidence and its limits. Model output, input acknowledgment, human confirmation, and independently verified success have separate meanings throughout the runtime.

## Author

Brad Clonan. [Email](mailto:clonanxyz@gmail.com). [LinkedIn](https://www.linkedin.com/in/bclonan). Read [the author profile](AUTHOR.md).

## License

The project is licensed under [MIT](LICENSE). Third-party components keep their own terms in [THIRD_PARTY.md](computer-use-runtime/THIRD_PARTY.md).
