"""Prepare the active provider trace. Refresh requires a reviewed source update."""
import hashlib
import json
from pathlib import Path

folder = Path(__file__).resolve().parent
root = folder.parents[1]
prefix = "window.ARCHITECTURE_SNAPSHOT = "
path = folder / "architecture-data.js"
data = json.loads(path.read_text(encoding="utf-8-sig").removeprefix(prefix).removesuffix(";\n"))


def source(name, marker=None):
    name = "computer-use-runtime/" + name
    raw = (root / name).read_bytes()
    lines = raw.decode("utf-8-sig").splitlines()
    matches = [index + 1 for index, line in enumerate(lines) if marker in line] if marker else [1]
    if not matches:
        raise ValueError("Provider source marker is missing: " + name + " " + str(marker))
    return {"path": name, "line": matches[0], "symbol": marker or name.removeprefix("computer-use-runtime/"), "sha256": hashlib.sha256(raw).hexdigest()}


def component(key, title, group, category, summary, details, refs):
    return {"id": key, "title": title, "group": group, "category": category, "summary": summary, "details": details, "sources": refs, "status": "Code traced. Live provider checks have their own execution scope.", "level": "detail"}


by_id = {item["id"]: item for item in data["components"]}
providers = by_id["ov-ollama"]
providers.update({"title": "Model providers", "group": "Proposal generation", "summary": "Ask selected Ollama or CLI models for bounded proposals and content.", "details": [
    "The chooser accepts one to four Ollama, Codex CLI or Claude CLI provider/model pairs. Their proposals are separate from owned ONNX skill selection.",
    "Ollama uses a trusted loopback daemon and rejects advertised cloud models. Codex uses its installed client and login. Claude requires API-key bare mode and is text only in this adapter.",
    "External providers require explicit consent for task text, controls, artifact source and enabled screenshots. The task freezes choices, strategy and consent.",
    "Ordered fallback returns the first valid response. Parallel ensemble groups matching JSON proposals, can select an existing candidate, and uses declared priority when selection fails.",
    "Every proposal still needs schema checks, deterministic policy, fresh observations and human input review. Model agreement does not prove completion.",
    "HTTP and CLI transports enforce byte budgets and cancellation. Discovery does not prove login, account limits or model access."
], "sources": [source("src/providers/settings.ts", "export function providerSettings"), source("src/providers/selection.ts", "export function createSelectedProvider"), source("src/providers/team.ts", "export class TeamProvider"), source("src/providers/cli.ts", "export class CliModelProvider"), source("src/providers/index.ts", "export class OllamaProvider")]})
by_id["ov-planner"]["details"][0] = "LocalDesktopPlanner sends accessible controls, scoped history and enabled screenshots to the task's frozen provider selection. External clients require consent."
by_id["ov-artifacts"]["details"][0] = "The API freezes provider selection, strategy, consent, source, output path and handwritten criteria. Pasted source has a 262144 UTF-8 byte bound."
by_id["ov-artifacts"]["details"][2] = "The constructor asks selected models for output, independently recomputes rows/calculations, and performs bounded repair on failure."
desktop = by_id["learning-console-desktop"]
desktop["summary"] = "Chooses model providers and reviews each proposed desktop action."
desktop["details"][1] = "The shared ModelPicker sets provider/model pairs, strategy and external consent. It does not activate an owned CNN/GRU model."
desktop["details"][4] = "The first available local model is the initial choice. Custom models require a fixed installed provider. Changing models or screenshot input clears external consent. No provider weights are downloaded."
desktop["sources"] = [source("console/DesktopWorkspace.vue", "async function submit"), source("console/ModelPicker.vue"), source("src/providers/settings.ts", "export function providerParameters")]
planner = by_id["learning-desktop-planner"]
planner["title"] = "Selected desktop plan proposal"
planner["summary"] = "Asks selected providers for bounded actions tied to current controls and enabled pixels."
planner["details"][0] = "next resolves frozen provider choices, strategy and consent, then constructs a schema containing current controls, launcher IDs, windows and supported operations."
vision = by_id["learning-vision-opinion"]
vision["details"][0] = "SelectedVisionAssessor sends the verified canvas crop and subject to selected vision-capable providers. Claude CLI is text only and cannot assess a screenshot."
vision["details"][2] = "A selected-provider assessment records provider results and is not calibrated. The legacy local assessor has a source/subject/model-bound cache for identical bytes. Neither authorizes input or proves completion."
vision["sources"] = [item for item in vision["sources"] if item["path"] != "computer-use-runtime/src/providers/assessment.ts"] + [source("src/providers/assessment.ts", "export class SelectedVisionAssessor")]
by_id["req-desktop-planner"]["details"][1] = "Language and enabled vision generation use frozen model provider settings. External clients require consent. The model does not own input. Confirmation records completed_by_user when independent completion is unavailable."
by_id["req-drawing"]["summary"] = "Selected providers propose a bounded composition. The compiler freezes paths and shapes into a line plan. Approval binds its target frame, canvas bounds, provider record, task budget and hash before Runtime draws."
by_id["req-ollama"]["summary"] = "OllamaProvider sends typed generation requests to a trusted loopback daemon. Readiness checks require advertised completion or vision capabilities and reject cloud metadata before private prompts or images. Selected CLI clients have a separate consent and transport path."

new_components = [
    component("provider-picker", "Model selection and consent", "User choice", "client", "Choose one to four models and explicitly permit external input.", [
        "Desktop and Artifacts share ModelPicker. Discovery includes installed Ollama models, fixed CLI binaries and supported custom names.",
        "The picker clears remote consent after model or screenshot changes. Server settings reject external selections without allowRemote=true.",
        "Task parameters freeze plannerProviders, providerStrategy and allowRemote. Legacy one-model requests still mean Ollama.",
        "A visible or installed model is not proof of authentication, account quota or successful execution."
    ], [source("console/ModelPicker.vue"), source("src/providers/settings.ts", "export function providerSettings"), source("src/providers/settings.ts", "export function taskProviderSettings")]),
    component("provider-team", "Fallback and ensemble", "Proposal selection", "models", "Validate model outputs and select one existing candidate.", [
        "Fallback tries members in the declared order and returns the first schema-valid response. Later members remain unused.",
        "Ensemble calls members in parallel and groups exact JSON proposals. A unique largest matching group with agreement wins.",
        "When valid candidates disagree, one bounded call asks the first valid member to select an existing candidate number. It cannot create or rewrite a candidate.",
        "Invalid or failed selection uses declared priority. Cancellation or expiry returns no candidate. Traces record member outcomes and selection method.",
        "Parallel selection can consume up to four proposal calls plus one selection call. Agreement and selection are model opinions, not input permission or independent verification."
    ], [source("src/providers/team.ts", "export class TeamProvider"), source("src/providers/selection.ts", "export function createSelectedProvider")]),
    component("provider-cli", "Installed CLI adapters", "External model transport", "models", "Ask fixed installed clients for JSON proposals in disposable directories.", [
        "The adapter discovers Codex and Claude by fixed executable names. HTTP input cannot choose a binary. Prompts are stdin data and argument arrays use no shell.",
        "Codex uses an ephemeral read-only session and a tool-free bundled model catalog. Unexpected tool events reject the answer. Claude requires API-key bare mode, refuses known managed policy, accepts text only and remains live-unverified here.",
        "Requests have a 120-second deadline, a 4 MiB combined output bound and an 8 MiB prompt bound. At most four PNG attachments share an 8 MiB image budget.",
        "Windows starts the child suspended in a private kill-on-close Job Object and verifies descendant settlement. Unix uses a detached process group and has no separate crash guardian.",
        "Temporary request files are removed after settlement. A trusted compatible client remains required. Rejection cannot undo any unexpected tool operation that already occurred."
    ], [source("src/providers/cli.ts", "export class CliModelProvider"), source("src/providers/cli.ts", "export function cliArguments"), source("src/providers/cli.ts", "export function codexProposalCatalog"), source("src/providers/cli-windows.py")]),
    component("provider-assessment", "Canvas model opinion", "Result inspection", "models", "Describe the current canvas without declaring objective completion.", [
        "SelectedVisionAssessor sends only the scoped canvas PNG and subject to the chosen vision providers.",
        "The response identifies the visible subject and recognizable flag. It also retains member results and selected proposal metadata.",
        "independentlyVerifiedCompletion and calibrated remain false. The assessment cannot approve input or change a drawing task into succeeded.",
        "The owned development dog had 90 acknowledged actions, changed canvas pixels, human inspection and a separate positive Qwen opinion. The task remained needs_review."
    ], [source("src/providers/assessment.ts", "export class SelectedVisionAssessor"), source("src/service/index.ts", "SelectedVisionAssessor")])
]
for item in new_components:
    if item["id"] in by_id:
        by_id[item["id"]].update(item)
    else:
        data["components"].append(item)

edges = [
    ("ov-console", "provider-picker", "Choose models", "The shared picker supplies provider choices and consent.", [source("console/ModelPicker.vue")]),
    ("provider-picker", "ov-api", "Freeze settings", "Server validation rejects missing external consent before a provider call.", [source("src/providers/settings.ts", "export function providerSettings")]),
    ("ov-api", "provider-team", "Construct model team", "The service creates the selected provider implementation.", [source("src/providers/selection.ts", "export function createSelectedProvider")]),
    ("provider-team", "provider-cli", "External proposal call", "Selected CLI clients receive approved input through bounded owned processes.", [source("src/providers/cli.ts", "export class CliModelProvider")]),
    ("provider-team", "learning-local-provider", "Local proposal call", "Selected Ollama models use the loopback transport.", [source("src/providers/index.ts", "export class OllamaProvider")]),
    ("provider-team", "ov-planner", "Select one proposal", "A valid existing model response enters ordinary decision validation and review.", [source("src/assistant/local.ts", "createSelectedProvider")]),
    ("provider-team", "ov-artifacts", "Construct candidate output", "Model content still passes the artifact's independent value checks.", [source("src/service/index.ts", "createSelectedProvider(settings.providers")]),
    ("provider-team", "provider-assessment", "Assess scoped pixels", "The selected vision team supplies an uncalibrated canvas opinion.", [source("src/providers/assessment.ts", "export class SelectedVisionAssessor")]),
    ("provider-assessment", "ov-store", "Save opinion separately", "The service journals assessment metadata without proving completion.", [source("src/service/index.ts", "SelectedVisionAssessor")]),
]
existing = {(item["from"], item["to"], item["label"]): item for item in data["relationships"]}
for start, end, label, detail, refs in edges:
    item = {"from": start, "to": end, "label": label, "detail": detail, "sources": refs}
    if (start, end, label) in existing:
        existing[(start, end, label)].update(item)
    else:
        data["relationships"].append(item)

ids = [item["id"] for item in new_components]
for view in data["views"]:
    if view["id"] in ["all", "models", "entry"]:
        view["components"] = list(dict.fromkeys(view["components"] + ids))
    if view["id"] == "models":
        view["summary"] = "Selected Ollama and CLI proposal models are separate from the owned PyTorch/ONNX skill controller. Consent and selection do not grant input authority."
provider_view = {"id": "providers", "title": "Providers and model choice", "summary": "Follow discovery, external consent, frozen settings, model proposal selection and ordinary action review.", "components": ["ov-console", "provider-picker", "ov-api", "provider-team", "provider-cli", "learning-local-provider", "ov-planner", "ov-guard", "provider-assessment", "ov-store"]}
data["views"] = [item for item in data["views"] if item["id"] != "providers"]
data["views"].insert(3, provider_view)

flow = {"id": "provider-selection", "title": "Choose and compare model proposals", "summary": "One to four selected models produce a proposal. External consent, validation and human review remain separate steps.", "steps": [
    {"component": "provider-picker", "title": "Choose models and input", "description": "Select provider/model pairs and fallback or ensemble. Changing models or enabled screenshots clears external consent.", "sources": [source("console/ModelPicker.vue")]},
    {"component": "ov-api", "title": "Validate and freeze consent", "description": "Server settings reject invalid pairs, duplicate selections and missing consent. The task freezes its provider choices and strategy.", "sources": [source("src/providers/settings.ts", "export function providerSettings"), source("src/providers/settings.ts", "export function providerParameters")]},
    {"component": "provider-team", "title": "Call the selected providers", "description": "Fallback tries members in order. Ensemble calls them in parallel. Every response must satisfy the caller's schema and byte budget.", "sources": [source("src/providers/team.ts", "export class TeamProvider")]},
    {"component": "provider-cli", "title": "Bound external client execution", "description": "CLI clients use fixed binaries, stdin prompts, disposable directories, disabled tools and bounded process cleanup. Claude is text only and requires an API key.", "sources": [source("src/providers/cli.ts", "export class CliModelProvider"), source("src/providers/cli-windows.py")]},
    {"component": "provider-team", "title": "Select one existing proposal", "description": "Matching proposals can win by agreement. Otherwise a member can select an existing candidate. Invalid selection uses declared priority; cancellation returns none.", "sources": [source("src/providers/team.ts", "selectionMethod = \"adjudicated\"")]},
    {"component": "ov-guard", "title": "Review and verify the action", "description": "The runner retains provider outcomes, then waits for ordinary human approval and fresh policy checks. Model agreement does not prove a desktop effect or task success.", "sources": [source("src/assistant/runner.ts", "provider_proposals"), source("src/runtime/policy.ts") ]}
]}
data["flows"] = [item for item in data["flows"] if item["id"] != flow["id"]]
data["flows"].insert(2, flow)
for item in data["flows"]:
    if item["id"] == "desktop-task":
        item["summary"] = "Selected models propose one action. Review, policy, fresh observations and native input checks still control execution."
        item["steps"][0]["description"] = "Choose This computer or a supported window, enter the goal, select models and strategy, and permit any external provider input."
        item["steps"][4]["description"] = "The planner sends accessible controls and enabled screenshots to frozen selected providers, validates the selected decision and retains it for review."

record = {"id": "provider-selection-record", "title": "Frozen provider selection", "storage": "TaskContract parameters; provider outcomes in run bindings and journal events", "lifetime": "Selections and consent stay with the task. Per-call outcomes remain in its journal.", "operations": ["select", "validate", "freeze", "inspect"], "details": ["plannerProviders stores provider/model pairs as bounded JSON. providerStrategy chooses fallback or ensemble. allowRemote records explicit external-provider consent.", "provider_proposals records member status and selection method. A valid model proposal is not an input approval or independently verified effect.", "This is task-local model configuration. It creates no account, chat or project record."], "sources": [source("src/providers/settings.ts", "export function providerParameters"), source("src/assistant/runner.ts", "provider_proposals")], "status": "code-traced"}
data["entities"] = [item for item in data["entities"] if item["id"] != record["id"]] + [record]
for item in data["components"]:
    for field in ["summary", "status"]:
        if isinstance(item.get(field), str):
            item[field] = item[field].replace("current 300-file", "earlier 300-file").replace("fresh 300-file", "earlier 300-file")
    item["details"] = [value.replace("current 300-file", "earlier 300-file").replace("fresh 300-file", "earlier 300-file") for value in item.get("details", [])]
path.write_text(prefix + json.dumps(data, ensure_ascii=True, separators=(",", ":")) + ";\n", encoding="utf-8", newline="\n")
print(json.dumps({"status": "PREPARED_PROVIDER_ARCHITECTURE_PENDING_REVIEWED_REFRESH", "components": len(data["components"]), "relationships": len(data["relationships"]), "journeys": len(data["flows"]), "entities": len(data["entities"]), "qualification": "No runtime or model qualification claimed"}))
