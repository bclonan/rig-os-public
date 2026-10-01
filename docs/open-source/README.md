# Public source release

Start with [USAGE.md](USAGE.md) for installation and a first task. [SYSTEM_OVERVIEW.md](SYSTEM_OVERVIEW.md) explains how the parts fit together. The [interactive architecture map](../system-map/index.html) has zoom, pan, searchable components, ordered journeys and source excerpts.

This is an experimental local desktop assistant and automation toolkit. It is useful for reviewed desktop actions, controlled browser workflows, recording reusable skills, local artifact generation and reproducible controller experiments. Its current limitations are in [VERIFICATION.md](VERIFICATION.md). Passing code checks do not close the live platform and learned-transfer gaps.

The project uses the [MIT license](../../LICENSE). Third-party dependencies and optional models keep their own terms in [THIRD_PARTY.md](../../computer-use-runtime/THIRD_PARTY.md) and the `licenses` directory. `private: true` in the Node package prevents accidental npm publication. It does not limit the source license.

The [security audit](SECURITY_AUDIT.md) covers the original checkout and history. The public repository contains a reviewed export with new Git history. [EVIDENCE.md](EVIDENCE.md) explains why private records are absent. `EXPORT_MANIFEST.json` records copied source hashes and any publication edits. Documentation edits do not establish new runtime or model qualifications.

To prepare another public copy from the original private checkout:

```sh
python docs/open-source/export_public.py ../rig-os-public-copy --prepare-portable-evidence
python docs/open-source/normalize_public_evidence.py ../rig-os-public-copy
```

Use a new destination directory. The script refuses to overwrite an existing directory or write inside the original checkout. It preserves source and sealed controlled evidence, copies only current documentation, and rewrites links to private evidence as explicit disclosures. The preparation copy stays private until its metadata derivatives and source diff receive review. Review the manifest and scan the actual exported files before committing them.

Run Gitleaks on both exported files and the new Git history:

```sh
gitleaks dir --redact=100 --max-target-megabytes=100 .
gitleaks git --redact=100 --max-target-megabytes=100 .
```

Then run the documented quality commands and the public architecture verifier. Do not copy the original `.git` directory. Do not push the original private history as an alternative release.

The author is [Brad Clonan](../../AUTHOR.md). Public contact details and the full author biography appear there with the author's permission.
