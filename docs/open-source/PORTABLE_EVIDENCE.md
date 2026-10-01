# Portable learning evidence

The public release removes the author's local source directory and machine IDs from controlled training manifests and saved reports. `/PUBLIC_WORKSPACE/computer-use-runtime` is a neutral reference namespace. The resolver reads hash-matched images and inputs in your local copy. It never reads files from that reference namespace or the author's computer.

Model weights and controlled image bytes stay unchanged. Metadata paths, machine identity labels and the hashes that depend on those metadata files change. `PORTABLE_EVIDENCE.json` records the original and public hashes, the exact source changes, and the new static fingerprint. Original sealed records remain private and unchanged.

The public training-origin resolver admits one exact derivative tuple for training provenance. It still checks the protocol, complete member inventory, all selected artifact hashes, source hashes and model selection. The successful-terminal verifier keeps its historical tuple table unchanged. A publication derivative cannot use the historical successful-terminal exception.

Public unit tests check that separation and reject altered origin members, changed model/input bytes, copied signing keys and symlinked origins. To qualify the selected controller on your computer, prepare a new directory and run the ordinary local audit. Activation still requires a fresh signed terminal, matching source, metrics, model hashes and successful cleanup.

The base `verify:audit` command checks the public derivative's saved-byte consistency. It does not rerun the original task cases or authenticate the public copy as the original frozen report. Saved measurements remain historical, with the limitations recorded in [VERIFICATION.md](VERIFICATION.md).
