# Inside rig-os

Open [index.html](index.html) for the architecture canvas. It needs JavaScript, but no runtime, token, model, or network connection. If your browser blocks a direct file preview, run this from the repository root:

```sh
python -m http.server 4329 --bind 127.0.0.1 --directory docs/system-map
```

Open [the map preview](http://127.0.0.1:4329/). Use `python3` on macOS or Linux if needed. Ctrl+C stops this documentation server. It serves this folder and never calls the assistant service.

## Explore the map

System overview shows the main responsibilities. Click a box for its explanation, boundaries, relationships, and cited source. All code responsibilities includes overlapping module descriptions. Boxes can share a source file or process.

Choose a journey to follow the steps in order. Previous, Next, and the numbered steps move through it. Search checks every view. List shows readable cards. Source links open embedded file text with the cited line highlighted. Records explains persistence and identity. Source file index covers the maintained implementation, including files with no individual component citation.

Drag empty space to pan. Wheel, pinch, and zoom buttons change scale. Fit view frames the graph. Tab reaches controls; Enter opens a component. Arrow keys pan when the canvas has focus. Escape closes dialogs. Touch hardware remains untested.

The requested-concepts view explains why signup, payment, guest passes, Convex, cloud uploads, and product chats/projects have no execution path here. Local token authentication, a task workspace, and Ollama chat transport have different jobs.

Read [the plain system overview](../open-source/SYSTEM_OVERVIEW.md), [usage guide](../open-source/USAGE.md), and [detailed trace](TRACE.md). The [operating guide](../../computer-use-runtime/docs/RUNNING.md) is embedded too, so it opens when the preview serves only this folder.

## Source and evidence

[SOURCE_INDEX.json](SOURCE_INDEX.json) records embedded source hashes and citations. [PUBLICATION_BINDING.json](PUBLICATION_BINDING.json) binds the public documentation refresh. The maintained fingerprint identifies actual source bytes. The revision displayed in the map is informational because a commit containing the generated map gets its ID after generation.

The public edition omits private stores, tokens, evaluator keys, personal captures, raw command logs, and historical review workspaces. References to omitted records open [the evidence disclosure](../open-source/EVIDENCE.md). Architectural roles and code anchors remain source-linked. Static inventory coverage does not claim a new manual review of every line.

Runtime, model, and native-platform results have their own scopes. The saved family study failed its learned-transfer gate. Mac live execution, physical mixed-DPI, external integration, and general native learning remain open. Read [public verification](../open-source/VERIFICATION.md), [feature matrix](../../computer-use-runtime/docs/FEATURE_MATRIX.md), and [repair status](../../computer-use-runtime/docs/REPAIR_STATUS.md).

## Refresh and verify

For changes to ordinary documents, run from the repository root:

```sh
python docs/system-map/refresh_publication.py
python docs/system-map/verify_publication.py
node --check docs/system-map/canvas.js
```

Refresh replaces embedded ordinary documents and reanchors their citations. It rejects maintained source changes unless an explicitly reviewed publication diff and exact before/after hashes accompany them. Use `--accept-public-source` only with the reviewed `docs/open-source/PORTABLE_EVIDENCE.json` record. That path records portable provenance derivatives. It does not authorize unrelated code changes or qualify a model.

After behavioral code changes, read the affected code and update the component and journey descriptions. Review those changes before refreshing. Hash acceptance alone cannot show that a description still matches new behavior.

The checker verifies all maintained hashes, embedded text, source-line bounds, graph endpoints, journey/view references, source index, canvas controls, and current local Markdown links. It makes no runtime calls. [The older verification notes](VERIFICATION.md) describe historical checks and their original bytes. Private historical builders and research stay preserved in the author's working repository.
