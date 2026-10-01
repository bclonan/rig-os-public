# Contributing

Start with [the usage guide](docs/open-source/USAGE.md) and [the system overview](docs/open-source/SYSTEM_OVERVIEW.md). The interactive [architecture map](docs/system-map/index.html) has source links and user journeys.

Use Node 24.17 through 24.x. Work from `computer-use-runtime`, run the setup script for your OS, and use a temporary `CUR_DATA` store for experiments. Never use someone's normal service store for tests.

Before changing behavior, read [AGENTS.md](computer-use-runtime/AGENTS.md), the architecture, handoff, definition of done and code standards it names. Keep model proposals separate from permissions and completion evidence. Preserve sealed model and audit bytes.

Run these checks from `computer-use-runtime`:

```sh
npm run check
npm run verify:audit
npm audit --audit-level=high
python -m unittest discover -s tests -p "*_test.py"
```

For native Rust changes, also run:

```sh
cargo fmt --manifest-path native/Cargo.toml -- --check
cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings
```

Describe the bug or use case, what changed, and the checks you ran in your pull request. Label browser fixtures, simulated workers and real desktop results separately. A skipped platform test is not a passing platform result. Update the docs and refresh the public map when responsibilities, commands or records change.

Do not include service tokens, evaluator keys, databases, recordings of personal apps or downloaded provider weights. Before publishing a branch, scan its files and Git history with Gitleaks. The [publication guide](docs/open-source/README.md) explains the release boundaries.

Contributions use the repository's [MIT license](LICENSE). Third-party components keep their own licenses and notices.
