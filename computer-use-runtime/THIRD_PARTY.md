# Third-party components

Source inspection took place on 2026-09-29. Commit identifiers below are the inspected snapshots. npm package versions come from package-lock.json, not repository HEAD. No code from game-client injection or anti-cheat projects was imported.

## Runtime dependencies

The implementation directly uses XState, Playwright, Vue, Fastify, TypeBox, Ajv, ONNX Runtime, the official MCP SDK, PyTorch, NumPy, Pillow, ONNX, and the Rust Windows bindings. Exact package versions and declared licenses are in evidence/dependency-manifest.json and the lockfiles. Installed third-party runtimes are not included in the source archive. Retain their license and notice files when redistributing those runtimes.

Oculix is used through the pinned MCP interface. Source MCP reports version 4.0.0 and requires Java 17 or later; its README described an older version and Java requirement. The tested isolated JDK is Temurin 21.0.12.1+1. The built MCP jar is about 214 MB. The archive supplies the bootstrap script, exact commit and license instead of redistributing the jar and its transitive binary payload. Tools were discovered live and checked against their schemas. The current runtime admits Oculix capture only. Its pinned global input tools cannot bind the target and lease at dispatch, so guarded Rust input executes those actions. Earlier Oculix input smoke evidence stays historical.

## Inspected research candidates

The Unix desktop worker uses PyObjC, pinned in `native/unix/requirements-macos.txt`, and distribution-installed PyGObject, AT-SPI2, python-xlib and Pillow on Linux. Wayland additionally uses the public XDG RemoteDesktop/ScreenCast D-Bus interfaces, GI/GStreamer and the authorized PipeWire stream. These system packages are not redistributed in the archive. Apple bindings follow upstream PyObjC API tests, with no native Mac execution claim. Linux reports describe their installed environment separately from the original Windows dependency manifest. See [PLATFORMS.md](PLATFORMS.md).

The portal development environment used Mutter 43.8, GNOME portal 43.1, XDG frontend 1.16, PipeWire 0.3.65 and its GStreamer plugin 0.3.65. That plugin version is separate from GStreamer core. It exercised actual consent on a headless compositor, not GNOME Shell or XWayland. Protocol, mapping, timestamp/cache limits and exact primary-source references appear in [evaluation/linux-portal-profile.md](evaluation/linux-portal-profile.md). The package implements its own portal client against those public APIs. Generic compositor and fractional-scale behavior still need separate validation.

| Repository | Commit | Repository license | Reuse |
|---|---|---|---|
| [oculix-org/Oculix](https://github.com/oculix-org/Oculix) | `02ea8844483a83a2963db8016cd7ad421e15bc91` | MIT | Actual MCP tools and pinned source build |
| [OpenAdaptAI/openadapt-flow](https://github.com/OpenAdaptAI/openadapt-flow) | `6e4e4ed0fe4addedd7c38ced44176b42bc40165a` | MIT | README/license reviewed; no code or weights imported |
| [microsoft/UFO](https://github.com/microsoft/UFO) | `a795552d976c4c019d7c2f778a0effb5cef7de6b` | MIT | README/license reviewed; no code or weights imported |
| [bytedance/UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop) | `2ff41a9e515828c5bd5b276e493d73aa0bdf4a3a` | Apache-2.0 | README/license reviewed; no code or weights imported |
| [simular-ai/Agent-S](https://github.com/simular-ai/Agent-S) | `3aa272d23d2994c7bbde1acbbe0ef8e8d06b8693` | Apache-2.0 | README/license reviewed; no code or weights imported |
| [xlang-ai/OpenCUA](https://github.com/xlang-ai/OpenCUA) | `dfc91ba89f700d10f26ec50362d308571482ab8b` | MIT | README/license reviewed; no code or weights imported |
| [microsoft/OmniParser](https://github.com/microsoft/OmniParser) | `354021201345a96178360b28733573e27269f2de` | CC-BY-4.0 | README/license reviewed; no code or weights imported |
| [statelyai/xstate](https://github.com/statelyai/xstate) | `fbee62e7c1586315ed478c2fedf530d7e0ff5a3e` | MIT | Maintained statechart executor, npm 5.33.2 |
| [microsoft/playwright](https://github.com/microsoft/playwright) | `5f47e4fb551fa486aec567b05ee11dc7ea6bbeda` | Apache-2.0 | Browser adapter, npm 1.63.0 |
| [RaiMan/SikuliX1](https://github.com/oculix-org/SikuliX1) | `c6f17990494541974353a7c64987f41c6761e612` | MIT | README/license reviewed; no code or weights imported |
| [Villavu/Simba](https://github.com/Villavu/Simba) | `2591bfe12142b71d370d08f89bf08c5edc95aeaf` | GPL-3.0 | README/license reviewed; no code or weights imported |
| [SRL/SRL](https://github.com/SRL/SRL) | `5091fdf67d50d8bd7929893611923cb09a845f33` | GPL-3.0 | README/license reviewed; no code or weights imported |
| [Ineedajob/RSBot](https://github.com/Ineedajob/RSBot) | `284cef97c799d8f509006a8bf1e848ab96e3c27f` | GPL-3.0 | README/license reviewed; no code or weights imported |
| [open-rpa/openrpa](https://github.com/open-rpa/openrpa) | `b78115e45bcfdc1a22398662bac355fdd52fac87` | MPL-2.0 | README/license reviewed; no code or weights imported |
| [PrismarineJS/mineflayer-statemachine](https://github.com/PrismarineJS/mineflayer-statemachine) | `30193e6d7fec2754a3de72876abeeaf6931cd23d` | MIT | README/license reviewed; no code or weights imported |
| [microsoft/WindowsAgentArena](https://github.com/microsoft/WindowsAgentArena) | `6d39ed88c545a0d40a7a02e39b928e278df7332b` | MIT | Pinned computer_13 contract, concrete private coordinator transport and mapper tests; no benchmark VM score |
| [xlang-ai/OSWorld](https://github.com/xlang-ai/OSWorld) | `b138d348256078fa634fc3b73567a7337c793e6b` | Apache-2.0 | Pinned computer_13 contract, concrete private coordinator transport and mapper tests; no benchmark VM score |

Model, dataset and source licenses are separate. OmniParser weights/data were not downloaded and their separate terms were not admitted as dependencies. Repository license metadata alone does not establish a model/data license. GPL research candidates and MPL OpenRPA remain references only.

## Models and data

The owned controller code and controlled fixture generator were written in this package. No pretrained encoder or external training dataset is included. qwen3:1.7b and qwen3.5:0.8b are optional local providers. Their installed metadata, digests and license text are recorded separately. An earlier creative plan using the already-installed qwen3.6:latest failed semantic acceptance. The historical 273-file drawing check used qwen3.6:latest for construction and qwen3.5:4b for a separate canvas opinion and prescribed negatives. That opinion is not an objective subject-verification claim. No local provider weights are in the archive.

The image-input adapter follows [Ollama's documented vision API](https://docs.ollama.com/capabilities/vision). It checks advertised vision support before sending a canvas crop. No private or undocumented subscription API is used.

Current language and vision readiness inspect local Ollama metadata and reject advertised cloud/remote-backed models before sending private prompts or images. Optional provider models remain separate from the owned controller and its sealed/followup training data. Saved provider, artifact and drawing results retain their original source identities in [docs/VERIFICATION.md](docs/VERIFICATION.md). They retain historical failures and do not establish a general desktop success rate. The runtime never downloads provider weights at startup.

The earlier 300-file V4 qualification and explicit seed-17 activation passed. [The primary receipt](../docs/open-source/EVIDENCE.md) records all three command exits as zero and settled cleanup. [Independent metric review](../docs/open-source/EVIDENCE.md) and [whole-current review](../docs/open-source/EVIDENCE.md) verify all 2,100 tasks, 300 head cases, exact selected weights, current source and signed finalization. [A separate public-operation supplement](../docs/open-source/EVIDENCE.md) completed one browser task with two bound acknowledgments and an independently read result, then rolled back to `fixed`. These are exposed-case source requalification and disposable-Store checks. They do not train new weights, activate the user's Store or establish unseen-task or native learning. The qualified controller is this project's own model. Its source replay does not change provider model licenses or redistribute Ollama weights.

The benchmark mapper follows the pinned [OSWorld action definitions](https://github.com/xlang-ai/OSWorld/blob/b138d348256078fa634fc3b73567a7337c793e6b/desktop_env/actions.py) and [WindowsAgentArena action definitions](https://github.com/microsoft/WindowsAgentArena/blob/6d39ed88c545a0d40a7a02e39b928e278df7332b/src/win-arena-container/client/desktop_env/envs/actions.py). Runtime key chords map to supported PRESS/HOTKEY keys, signed wheel amounts map to SCROLL dx/dy, and a drag emits MOVE_TO at its start followed by DRAG_TO at its absolute destination. No benchmark source, evaluator configuration, rewards or private answers enter the runtime observation. Test results cover contracts and owned browser callbacks, not benchmark VM scores.
