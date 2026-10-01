# Open-source security audit

The original checkout and its Git history should not be published as they stand. The scans found private machine paths and tracked raw evidence. They found no confirmed user password, provider key, private key or bearer token within the inspected content. The project also had no license for its own code at the start of this audit.

This is an October 1, 2026 snapshot over HEAD `25690943be8727fc13dd2354f7a2927d3ccbfae5`, including the uncommitted working tree. The [machine report](security-audit.json) records categories and file locations. It contains no secret values, contact values, author identities or full private OS paths. Later export checks must identify their own exact files and commit.

## What was checked

| Check | Scope and result |
|---|---|
| Working tree | 9,724 tracked files plus 1,611 untracked, nonignored files at the scan snapshot. 11,335 existing candidate files, about 593 MB. |
| Static text scan | 2,388 working-tree text files and 2,179 historical text blobs. Provider token formats, private-key headers, credential literals/URLs, bearer values, personal OS paths, owner identifiers and email addresses. |
| Reachable history | All 15 commits and 7,576 unique reachable file blobs. Duplicate content was reused during scanning. |
| Gitleaks | Checksum-verified official version 8.30.1, full history, full redaction. It scanned 219.37 MB and reported 40 generic-api-key matches. |
| Models | Owned checkpoint and ONNX files, plus small ZIP members, checked for private owner-path ASCII strings. None found. The report records the count. |
| Service data | The audit did not open the user's runtime Store, databases, service tokens or evaluator keys. |

Gitleaks' 39 JSON matches are SHA-256 file digests associated with `evaluation/macos-api-check.py`. They are false positives. The remaining match is a resource-link token in an old upstream README copy, outside the recommended public export. The custom scanner's secret-like source matches are negative-test credentials and a dummy console test token. Historical upstream copies also have example keys and documented benchmark default passwords. Those copies should stay outside the new source repository.

## Publication blockers

The ignore rules match 256 files that Git already tracks. `.gitignore` cannot remove their contents or prior commits. These include raw completion records, desktop captures and diagnostic artifact files. Removing them from the next commit would still leave them in old history. The requested new repository needs a fresh `.git` directory.

Private OS paths occur in 321 working-tree files and 282 historical blobs. Raw reports also contain dependency/cache locations under the user profile. Old root-review and architecture-map backup directories repeat these paths. Export the maintained documentation and current map, then sanitize their unsealed metadata. Preserve the original evidence in the private checkout.

The package's current evidence allowlist is not sufficient by itself. It admits exact-byte provenance with private workspace paths. The controlled subset contains 10,489 path matches under the same component workspace root, across 2,106 distinct full paths. This includes `evidence/results.json:433`, V1-V4 browser manifests, and `evidence/learning-followup-v4-training-origin-v1/results.json:981` and `selection.json:544`. Changing those bytes can invalidate hashes, signed audit records and model admission. The user rejected retaining that private root. The public export must use a separately labeled portable metadata derivative or omit the private metadata. Recompute its transitive hashes and document its relation to the private original. Do not edit the original sealed files or claim a sanitized copy has the original seal.

Four ignored V1-V4 browser `training.log` files contain eight references to a private AppData Python-library directory. Exclude all logs. No Downloads, Desktop, other user-root, uppercase Windows device-name or MAC-address pattern appeared in the initial controlled evidence checks. A later structured-field check found actual hardware hostname metadata that those patterns missed. The public derivative must replace exact private host-field values with a neutral fixture identity. The machine report records the file and occurrence counts without hostname values. The broader raw checkout has private AppData and dependency/model-cache references that must remain outside the export.

The initial tree has `THIRD_PARTY.md`, 14 upstream license texts, pinned upstream references, dependency manifests and lockfiles. It has no license file for owned code and no package `license` field. `package.json` sets `private: true`, which prevents accidental npm publication but does not grant a source license. The reviewed public export now includes a root MIT license for owned code. Retain third-party notices. The source export should not redistribute optional provider weights, the Oculix jar or installed third-party runtimes.

Git history contains two name identities and two email identities. The report omits their values. Use the expressly approved public contact and professional biography for the new repository. Do not copy old Git configuration or author metadata by default.

## Export rules

Use the maintained source, lockfiles, instructions, current architecture map and reviewed controlled evidence as an allowlist. Exclude `.git`, runtime data, credential/key files, dependency folders, downloaded tools, logs, raw desktop inspections/captures, raw completion attempts, historical documentation backups and upstream inspection source/README copies. Keep only the third-party provenance and license records needed to explain dependencies.

After preparing the new directory, run a separate credential and privacy scan on its actual bytes and its fresh history. Record every portable metadata derivative with its source and output hashes. Exact derivative-origin trust must not waive current-source qualification, a fresh local evaluator attestation, successful finalization or cleanup. A clean source scan does not certify screenshots, copied credentials inside a future recording, all dependencies or native platform behavior. New recordings and private training datasets remain private by default.

## Limits

This audit supports a controlled export. It does not certify that every possible secret is absent. Text scanners cannot inspect image pixels; the image inventory includes generated fixtures and private desktop captures. Preserve controlled provenance and exclude unrelated captures. The binary model check searched strings and ZIP members, without loading or executing model files. Final publishing readiness depends on the finished export, its license, its passing checks and the stated platform limits.

## Public export review

The portable metadata derivative passed an independent original-to-export review. All 70 metadata file hashes match the derivative manifest. The three maintained source changes admit an exact public training origin and test its limits. The original terminal verifier remains byte-identical. The derivative cannot substitute for fresh local qualification, signed terminal evidence or successful cleanup. The focused training-origin and finalization tests passed all 27 checks.

The metadata changes replace private workspace paths, replace 37,658 exact structured hostname fields, update dependent hashes and label the publication origin. Numeric and Boolean values remain unchanged. The peer review found no other semantic changes in the controlled JSON and JSONL content.

Two full-console screenshots contained a machine label and were omitted. The remaining 2,125 model and image files match their private originals byte for byte. That count contains 36 ONNX files, 36 PT files and 2,053 PNG files. The [portable evidence record](PORTABLE_EVIDENCE.json) lists the omissions and reviewed changes. The derivative records the relationship to the private evidence. It does not claim a new execution or the original seal.

The public working-tree scan passed with no secret findings or private owner paths or structured hostname fields. The scan snapshot covered 2,715 Git-index-listed files and 133,159,020 bytes. It checked their working bytes in a separate scanner directory. [The scan report](public-scan.json) records its exact input-tree digest. Later document writes, the final commit and a byte-preserving clone require their own checks. A passing privacy scan does not establish native-platform qualification or production model readiness.

## Reviewed scanner exceptions

The root `.gitleaks.toml` extends every default detector. Three rule-specific exceptions apply only to `generic-api-key`. Each requires an exact controlled evidence or publication-binding path and a byte-verified source digest. Complete JSON key lines admit the known Mac API checker digest or the known API correlation test digest. The Mac checker digest also has an exact-secret exception in the publication binding's path-and-digest records. These are source fingerprints, not credentials.

The exceptions do not suppress whole files, directories, commits or arbitrary hexadecimal strings. All seven synthetic unknown-secret canaries still trigger detection. They cover adjacent API keys, unknown values under the same source keys, the verified digest outside controlled paths and V4 training-origin metadata. The machine report records the final configuration SHA-256, source paths and canary counts. See [Gitleaks configuration](https://github.com/gitleaks/gitleaks/blob/v8.30.1/README.md#configuration) for the rule-specific AND semantics.
