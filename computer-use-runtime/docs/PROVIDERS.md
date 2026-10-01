# Choose model providers

Desktop and Artifacts share one model chooser. Select one to four provider/model pairs. The first available Ollama model is the default. The service never downloads a model or silently switches a local task to a remote provider.

| Provider | Setup | Inputs and current evidence |
| --- | --- | --- |
| Ollama | Install Ollama, start its loopback server and install a model. | Text; PNG screenshots when the model supports vision. The current Windows development run used Qwen 3.6 to plan an 88-segment dog drawing. |
| Codex CLI | Install Codex, run `codex login`, then restart the service. | Text and explicit PNG attachments. Default model and `gpt-5.5` returned valid structured desktop decisions in live checks. Account access determines which model names work. |
| Claude CLI | Install a compatible Claude Code CLI and configure `ANTHROPIC_API_KEY`. | Text only. The adapter uses bare mode and refuses OAuth-only use. Claude is absent on the development host, so no live Claude result is claimed. |

CLI model names come from discovery or the custom model form. `default` lets the CLI choose its default model. Installed binaries do not prove that login, account limits or a chosen model work. Model names accept at most 200 characters and cannot become command flags. Ollama cloud models are unavailable through the local adapter.

## Use the chooser

1. Start the service, connect with its token and open Desktop or Artifacts.
2. Select the models. Use the custom model form if a supported model is absent from discovery.
3. Choose ordered fallback or parallel evaluation.
4. If a CLI provider is selected, explicitly allow it to receive task text, artifact source content and any enabled screenshots. Account charges may apply. Changing the selected models or screenshot setting clears this consent.
5. Submit the task and review its proposal or output. A model never approves desktop input.

Desktop normally sends accessibility text. Enable the screenshot checkbox only for vision-capable selections. Known text-only selections block image requests, and the server also checks capabilities. Claude cannot receive screenshots through this adapter. The drawing assessment button sends only the canvas image to the selected vision providers.

## What fallback and parallel evaluation do

Ordered fallback tries models in selection order and stops at the first response that passes the requested JSON schema. The trace records later models as unused.

Parallel evaluation asks up to four models for separate proposals. Each response must pass the same schema and byte limits. Exact matching JSON proposals vote together. A unique largest matching group wins. If valid proposals disagree without a clear winner, one additional call asks the first valid provider to select an existing candidate number. It cannot rewrite a candidate. An invalid selection falls back to declared model priority. Cancellation or expiry returns no proposal.

This is an application-level proposal ensemble. It does not mix neural weights, train a router or implement a neural mixture of experts. A winning proposal still passes ordinary policy, fresh-observation checks and human review.

Desktop runs and drawing previews show each provider's valid, failed or unused status, the selected member and the selection method. Safe failure categories retain HTTP status where useful. Arbitrary provider error text stays out of these traces.

## Request format

Legacy requests with one `model` still choose Ollama. New requests use the following fields on desktop, drawing and artifact routes:

```json
{
  "providers": [
    { "provider": "ollama", "model": "your-installed-model" },
    { "provider": "codex-cli", "model": "default" }
  ],
  "strategy": "fallback",
  "allowRemote": true
}
```

Keep the route's other fields, such as goal, window identity or artifact specification. Use the service token, idempotency key and correlation header. Missing remote consent rejects the request before provider execution. Persisted desktop tasks freeze provider choices, strategy and consent in their parameters.

## CLI execution boundaries

The adapter discovers fixed executable names. HTTP clients cannot supply an executable path. It sends prompts through stdin, uses argument arrays without a shell and works in a private temporary directory. CLI requests have a 120-second deadline, a combined 4 MiB output limit and an 8 MiB prompt limit. PNG attachments have a shared 8 MiB limit and a maximum of four images. Temporary prompt metadata and images are removed after the request.

Codex ignores user rules and ordinary configuration, uses an ephemeral read-only session and derives tool-free model metadata from its bundled catalog. It removes apply-patch and experimental tools and disables configured MCP servers, command execution, browser/app integrations, hooks, plugins and local-image reading. It validates strict structured output, then restores only null placeholders introduced for originally optional fields and validates the original schema again. Unexpected tool events reject the response. These restrictions depend on a trusted compatible CLI and its sandbox. They do not sandbox a malicious same-user executable, and a rejected response cannot undo a tool operation that already happened.

Claude bare mode skips the ordinary OAuth/configuration path. The adapter requires an API key, disables tools and MCP, and rejects known managed policy files or settings. Ordinary `--setting-sources` flags alone do not exclude server-managed settings. Claude execution remains unverified until a compatible installed CLI passes live tests. See the official [CLI flags](https://code.claude.com/docs/en/cli-reference) and [managed settings precedence](https://code.claude.com/docs/en/managed-settings).

On Windows, Python starts the CLI suspended, assigns it to a private kill-on-close Job Object, then resumes it. The supervisor has its own deadline and confirms the job has no active processes before returning. It also terminates descendants that outlive an ordinary parent exit. Install Python 3.10 or newer and put its real interpreter on PATH if supervision is unavailable. Core setup does not install Python. The adapter also searches the runtime training virtual environment. Windows Store aliases are excluded. Source checkouts and source packages include `src/providers/cli-windows.py`; compiled JavaScript resolves that helper in the retained source tree.

On Unix, the adapter starts a detached process group and kills that group on timeout, abort or ordinary exit. It has no separate crash guardian. Descendants that escape the group, and coordinator-crash cleanup, are not qualified by the Windows tests.

Local provider endpoints reject redirects and non-loopback addresses. A trusted compatible daemon can still forward content elsewhere. A loopback address alone does not prove that the daemon keeps content local.

## Check the implementation

Run these from the runtime directory. Browser checks use disposable stores and provider fixtures; they do not make remote calls or send native input.

```sh
npm run check
npx tsx --test tests/provider-cli.test.ts tests/provider-team.test.ts tests/provider-settings.test.ts tests/provider-capabilities.test.ts
npx tsx evaluation/provider-console.ts
npx tsx evaluation/review-console.ts
```

The current development checks cover real subprocess stdin handling, timeout, abort, output overflow, descendant cleanup, schema rejection, ordered fallback, exact consensus and bounded candidate selection. Live Codex and Qwen returned valid proposals in a two-member ensemble. The console checks cover one to four models, custom names, consent reset, screenshot restrictions, failures, keyboard use and a 390-pixel mobile layout.

For an interactive Windows drawing check, the first command creates a separately owned Paint window and writes a preview to a temporary directory without sending drawing input:

```sh
npx tsx evaluation/provider-drawing.ts
```

Inspect the returned `preview.svg`. Only then execute the frozen plan using the directory printed by that command:

```sh
npx tsx evaluation/provider-drawing.ts --approve <returned-temporary-directory>
```

The current Qwen dog check acknowledged two setup clicks and 88 drawing segments, then measured a changed canvas. A human inspected the crude dog result. A separate Qwen 3.5 4B canvas assessment returned `recognizable:true` in 7,714 ms. That opinion was uncalibrated and did not change the task's `needs_review` status. The [curated check record](../../docs/open-source/PROVIDER_REPAIR_CHECKS.json) and [owned canvas image](../../docs/open-source/images/provider-dog.png) retain this development result. Personal desktop captures and temporary execution records stay private. Delivery, changed pixels and one model opinion do not prove that every subject is recognizable.

Earlier 273-, 299- and 300-file audit receipts describe their original source. They do not qualify the later provider, UI or drawing changes. Native Mac, physical mixed-DPI, external benchmark integration and general native learning remain open.
