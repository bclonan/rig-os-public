<script setup lang="ts">
import { computed, ref, onMounted, watch, onUnmounted } from "vue";
import type { RuntimeClient } from "../src/sdk/index";
import ModelPicker, { type ModelSelection } from "./ModelPicker.vue";
const props = defineProps<{
  client: RuntimeClient;
  runs: any[];
  providers: any;
  token: string;
}>();
const emit = defineEmits<{ refresh: [] }>();
let closed = false,
  semanticVersion = 0,
  timelineVersion = 0,
  selectionVersion = 0,
  drawingVersion = 0,
  windowsVersion = 0;
const windows = ref<any[]>([]),
  apps = ref<any[]>([]),
  system = ref<any>({}),
  platformNotes = ref(""),
  scope = ref("computer"),
  available = ref(false),
  reason = ref(""),
  chosen = ref(0);
const consent = ref<any>();
const consentBusy = ref(false);
const drawingPlan = ref<any>();
const modelPicker = ref<InstanceType<typeof ModelPicker>>();
const modelSelection = ref<ModelSelection>({
  providers: [],
  strategy: "fallback",
  allowRemote: false,
  model: "",
});
const paintWindow = computed(() =>
  windows.value.find((entry) =>
    String(entry.executable || "")
      .toLowerCase()
      .endsWith("mspaint.exe"),
  ),
);
async function planDrawing() {
  if (modelPicker.value?.validate() === false) return;
  await act(async () => {
    const client = props.client,
      version = ++drawingVersion;
    const window =
      scope.value === "computer"
        ? paintWindow.value
        : windows.value.find((entry) => entry.handle === chosen.value);
    if (!window) throw new Error("Choose a Paint window first.");
    const result = await client.request("/api/drawing-plans", "POST", {
      goal: goal.value,
      ...modelSelection.value,
      handle: window.handle,
      pid: window.pid,
    });
    if (!closed && client === props.client && version === drawingVersion)
      drawingPlan.value = result;
  });
}
async function approveDrawing() {
  await act(async () => {
    const plan = drawingPlan.value,
      client = props.client,
      version = drawingVersion,
      selection = selectionVersion;
    const run = await client.request(
      `/api/drawing-plans/${encodeURIComponent(plan.id)}/execute`,
      "POST",
      {},
    );
    if (
      closed ||
      client !== props.client ||
      version !== drawingVersion ||
      selection !== selectionVersion
    )
      return;
    selected.value = run.id;
    drawingPlan.value = undefined;
  });
}
const goal = ref(""),
  vision = ref(false),
  selected = ref(""),
  feedback = ref("");
const error = ref(""),
  busy = ref(false),
  image = ref(""),
  timeline = ref<any[]>([]);
const tasks = computed(() =>
  props.runs
    .filter(
      (r) =>
        r.contract.method === "desktop.assistant" ||
        r.contract.method?.startsWith("drawing."),
    )
    .slice()
    .reverse(),
);
const current = computed(() =>
  tasks.value.find((r) => r.id === selected.value),
);
const proposal = computed(() => current.value?.bindings.proposal);
const subject = ref("");
const semantic = ref<any>();
watch(
  [selected, () => props.client],
  () => {
    selectionVersion++;
  },
  { flush: "sync" },
);
watch(
  [chosen, goal, modelSelection, () => props.client],
  () => {
    drawingVersion++;
    drawingPlan.value = undefined;
  },
  { flush: "sync", deep: true },
);
async function assessCanvas() {
  if (modelPicker.value?.validate(true) === false) return;
  await act(async () => {
    const id = selected.value,
      client = props.client,
      version = ++semanticVersion;
    try {
      const result = await client.request(
        `/api/desktop/tasks/${encodeURIComponent(id)}/assess`,
        "POST",
        { subject: subject.value, ...modelSelection.value },
      );
      if (
        !closed &&
        client === props.client &&
        id === selected.value &&
        version === semanticVersion
      )
        semantic.value = result;
    } catch (e) {
      if (
        !closed &&
        client === props.client &&
        id === selected.value &&
        version === semanticVersion
      )
        throw e;
    }
  });
}
watch(
  [selected, subject, modelSelection, () => props.client],
  () => {
    semanticVersion++;
    semantic.value = undefined;
  },
  { flush: "sync", deep: true },
);
watch([selected, () => props.client], async ([id, client]) => {
  const version = ++semanticVersion;
  if (id) {
    try {
      const result = await client.request(
        `/api/desktop/tasks/${encodeURIComponent(id)}/assessment`,
      );
      if (
        !closed &&
        client === props.client &&
        id === selected.value &&
        version === semanticVersion &&
        result.assessment
      )
        semantic.value = result;
    } catch (error) {
      if (
        !closed &&
        client === props.client &&
        id === selected.value &&
        version === semanticVersion
      )
        console.warn("Saved assessment unavailable", error);
    }
  }
});
const labels: Record<string, string> = {
  queued: "Queued",
  running: "Reading the app and planning",
  awaiting_approval: "Review the next action",
  needs_review: "Review the result",
  awaiting_input: "Waiting for your instruction",
  paused: "Paused",
  cancelled: "Cancelled",
  completed_by_user: "Confirmed by you",
  reconciliation_required: "Interrupted action needs inspection",
  blocked: "Stopped with an error",
};
async function act(work: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  const client = props.client,
    selection = selectionVersion;
  try {
    await work();
    if (!closed && client === props.client) emit("refresh");
  } catch (e) {
    if (!closed && client === props.client && selection === selectionVersion)
      error.value = String(e);
  } finally {
    busy.value = false;
  }
}
async function refreshWindows() {
  const client = props.client,
    version = ++windowsVersion;
  const result = await client.request("/api/desktop/windows");
  if (closed || client !== props.client || version !== windowsVersion) return;
  available.value = result.available;
  reason.value = result.reason || "";
  windows.value = result.windows;
  apps.value = result.apps || [];
  system.value = result.system || {};
  platformNotes.value = result.notes || "";
  consent.value = result.consent;
  if (!windows.value.some((w) => w.handle === chosen.value)) chosen.value = 0;
}
async function requestConsent() {
  if (consentBusy.value) return;
  consentBusy.value = true;
  error.value = "";
  try {
    await props.client.request("/api/desktop/consent", "POST", {});
  } catch (e) {
    error.value = String(e);
  } finally {
    consentBusy.value = false;
    await refreshWindows().catch((e) => {
      error.value = String(e);
    });
  }
}
async function cancelConsent() {
  try {
    await props.client.request("/api/desktop/consent/cancel", "POST", {});
  } catch (e) {
    error.value = String(e);
  }
}
async function submit() {
  if (modelPicker.value?.validate() === false) return;
  const target =
    scope.value === "computer"
      ? paintWindow.value
      : windows.value.find((entry) => entry.handle === chosen.value);
  if (
    /\b(?:draw|sketch|paint)\b/i.test(goal.value) &&
    target &&
    String(target.executable || "")
      .toLowerCase()
      .endsWith("mspaint.exe")
  ) {
    await planDrawing();
    return;
  }
  await act(async () => {
    const client = props.client,
      selection = selectionVersion;
    const window = windows.value.find((w) => w.handle === chosen.value);
    if (scope.value === "window" && !window)
      throw new Error("Choose an open app first.");
    const run = await client.request("/api/desktop/tasks", "POST", {
      goal: goal.value,
      ...modelSelection.value,
      vision: vision.value,
      scope: scope.value,
      ...(scope.value === "window"
        ? { handle: window.handle, pid: window.pid }
        : {}),
    });
    if (closed || client !== props.client || selection !== selectionVersion)
      return;
    selected.value = run.id;
    feedback.value = "";
  });
}
async function review(command: string) {
  await act(async () => {
    const id = selected.value,
      client = props.client,
      selection = selectionVersion;
    await client.request(
      `/api/desktop/tasks/${encodeURIComponent(id)}/review`,
      "POST",
      { command, proposalId: proposal.value?.id, feedback: feedback.value },
    );
    if (closed || client !== props.client || selection !== selectionVersion)
      return;
    feedback.value = "";
  });
}
async function control(command: string) {
  await act(() => props.client.control(selected.value, command));
}
let imageVersion = 0;
watch(
  () =>
    [
      selected.value,
      props.client,
      props.token,
      current.value?.bindings.proposal?.observation?.image ||
        current.value?.bindings.observation?.image,
    ] as const,
  async ([id, client, token, hash]) => {
    const version = ++imageVersion;
    if (image.value) URL.revokeObjectURL(image.value);
    image.value = "";
    if (!hash) return;
    try {
      const response = await fetch(
        "/api/artifacts/" + encodeURIComponent(hash),
        {
          headers: { authorization: "Bearer " + token },
        },
      );
      if (
        closed ||
        version !== imageVersion ||
        client !== props.client ||
        id !== selected.value
      )
        return;
      if (!response.ok) throw new Error("Screenshot could not be loaded");
      const blob = await response.blob();
      if (
        !closed &&
        version === imageVersion &&
        client === props.client &&
        id === selected.value
      )
        image.value = URL.createObjectURL(blob);
    } catch (e) {
      if (
        !closed &&
        version === imageVersion &&
        client === props.client &&
        id === selected.value
      )
        error.value = String(e);
    }
  },
  { immediate: true, flush: "sync" },
);
watch(
  () => [
    props.client,
    current.value &&
      [current.value.id, current.value.status, current.value.cursor].join(":"),
  ],
  async () => {
    const id = selected.value,
      client = props.client,
      version = ++timelineVersion;
    timeline.value = [];
    if (!id) {
      timeline.value = [];
      return;
    }
    try {
      const events = await client.request(
        `/api/tasks/${encodeURIComponent(id)}/evidence`,
      );
      if (
        !closed &&
        client === props.client &&
        id === selected.value &&
        version === timelineVersion
      )
        timeline.value = events;
    } catch (e) {
      if (
        !closed &&
        client === props.client &&
        id === selected.value &&
        version === timelineVersion
      )
        error.value = String(e);
    }
  },
  { immediate: true, flush: "sync" },
);
const targetControl = computed(() =>
  proposal.value?.observation.controls?.find(
    (c: any) => c.index === proposal.value.decision.control,
  ),
);
const navigationTarget = computed(() => {
  const p = proposal.value;
  if (p?.decision.operation === "switch_window") {
    const w = p.observation.desktop?.windows.find(
      (w: any) => w.id === p.decision.window,
    );
    return w ? `${w.title} · process ${w.pid}` : p.decision.window;
  }
  return p?.observation.desktop?.apps.find((a: any) => a.id === p.decision.app)
    ?.name;
});
onMounted(() => {
  selected.value = tasks.value[0]?.id || "";
  void act(refreshWindows);
});
onUnmounted(() => {
  closed = true;
  semanticVersion++;
  timelineVersion++;
  imageVersion++;
  if (image.value) URL.revokeObjectURL(image.value);
});
</script>

<template>
  <div class="desktop-workspace">
    <p class="desktop-intro">
      Describe a task on your computer. The assistant can open apps, move
      between windows and use their controls. You review each action before it
      runs.
    </p>
    <p class="computer-status" v-if="system.name">
      {{ system.name }} {{ system.release }} · {{ system.arch }} ·
      {{
        available ? "Computer control ready" : "Computer control unavailable"
      }}
    </p>
    <p v-if="error" class="desktop-error" role="alert">{{ error }}</p>
    <p v-if="!available" role="status">
      {{ reason }}
    </p>
    <p v-else-if="platformNotes" class="hint">{{ platformNotes }}</p>
    <section
      v-if="consent?.required"
      class="panel"
      aria-label="Desktop permission"
    >
      <p role="status">
        {{
          consentBusy
            ? "Waiting for the system permission dialog"
            : consent.granted
              ? "Desktop input and capture permission granted for this session"
              : "Wayland desktop input and screenshots need permission in the system dialog"
        }}
      </p>
      <button
        v-if="!consent.granted"
        type="button"
        :disabled="consentBusy"
        @click="requestConsent"
      >
        Allow desktop input and capture
      </button>
      <button
        v-if="consentBusy"
        type="button"
        class="secondary"
        @click="cancelConsent"
      >
        Cancel permission request
      </button>
      <p class="hint">
        Accessible controls remain available without this permission. The system
        decides which devices and display this session can use.
      </p>
    </section>
    <div class="grid">
      <section class="panel">
        <h2>New desktop task</h2>
        <form
          action="/api/desktop/tasks"
          method="post"
          @submit.prevent="submit"
        >
          <fieldset class="scope-picker" aria-describedby="scope-hint">
            <legend>Work in</legend>
            <label class="desktop-check" for="scope-computer">
              <input
                id="scope-computer"
                name="scope"
                type="radio"
                value="computer"
                v-model="scope"
              />
              This computer
            </label>
            <label class="desktop-check" for="scope-window">
              <input
                id="scope-window"
                name="scope"
                type="radio"
                value="window"
                v-model="scope"
              />
              One window
            </label>
          </fieldset>
          <p id="scope-hint" class="hint">
            {{
              scope === "computer"
                ? "Switch between open apps or launch an app as part of the task. Each app change requires review."
                : "Keep this task inside one selected app and its owned dialogs."
            }}
          </p>
          <label v-if="scope === 'window'" for="desktop-window">Open app</label>
          <select
            v-if="scope === 'window'"
            id="desktop-window"
            name="window"
            v-model="chosen"
            required
          >
            <option :value="0" disabled>Choose a window</option>
            <option v-for="w in windows" :key="w.handle" :value="w.handle">
              {{ w.title }} · {{ w.pid }}
            </option>
          </select>
          <p v-if="scope === 'computer'" class="hint">
            {{ windows.length }} supported windows open. Can launch
            {{ apps.map((a) => a.name).join(", ") || "no apps on this OS" }}.
            Open other apps yourself, then refresh the list.
          </p>
          <button
            type="button"
            class="secondary"
            :disabled="busy"
            @click="act(refreshWindows)"
          >
            Refresh open apps
          </button>
          <label for="desktop-goal">What should the assistant do?</label>
          <textarea
            id="desktop-goal"
            name="goal"
            v-model="goal"
            required
            maxlength="4000"
            rows="4"
            :placeholder="
              scope === 'computer'
                ? 'For example, calculate 37 times 14, then write the result in a new text document without saving.'
                : 'For example, write a short meeting agenda in this blank document.'
            "
          ></textarea>
          <ModelPicker
            ref="modelPicker"
            id-prefix="desktop"
            :providers="providers"
            v-model="modelSelection"
            :screenshots="vision"
          />
          <label class="desktop-check" for="desktop-vision"
            ><input
              id="desktop-vision"
              name="vision"
              type="checkbox"
              v-model="vision"
            />
            Send screenshots to the selected providers</label
          >
          <p class="hint">
            Requires a vision model and screenshot access on this OS. Otherwise
            the assistant reads accessibility controls. Task history stays in
            the local store. Remote providers also receive the enabled inputs
            after you consent above.
          </p>
          <button :disabled="busy || !available">Plan desktop task</button>
          <button
            v-if="
              (scope === 'computer' && paintWindow) ||
              (scope === 'window' &&
                String(
                  windows.find((entry) => entry.handle === chosen)
                    ?.executable || '',
                )
                  .toLowerCase()
                  .endsWith('mspaint.exe'))
            "
            type="button"
            class="secondary"
            :disabled="busy || !goal.trim()"
            @click="planDrawing"
          >
            Plan a bounded Paint drawing
          </button>
          <p class="hint">
            Planning brings the selected app to the front. Return here to
            review. Every click, keystroke and text change needs your approval,
            including Save or Send.
          </p>
        </form>
        <div v-if="drawingPlan" class="desktop-review">
          <h3>Review the drawing program</h3>
          <p>{{ drawingPlan.task.goal }}</p>
          <details v-if="drawingPlan.providerResults">
            <summary>Drawing proposal sources and failures</summary>
            <ul>
              <li
                v-for="(member, index) in drawingPlan.providerResults.members"
                :key="index"
              >
                {{ member.provider }} {{ member.model }} , {{ member.status
                }}<template v-if="member.reason"
                  >. {{ member.reason }}</template
                >
              </li>
            </ul>
            <p>
              Selection method:
              {{ drawingPlan.providerResults.selectionMethod }}
            </p>
          </details>
          <p>
            {{ drawingPlan.segmentCount }} Pencil segments inside the selected
            canvas. Approval runs this bounded program. It cannot save,
            overwrite, import or upload an image. Review the subject afterward.
          </p>
          <p v-if="drawingPlan.setupActions?.length">
            The program first selects Pencil and black color in Paint.
          </p>
          <details>
            <summary>Geometric parts and frozen task</summary>
            <pre>{{ JSON.stringify(drawingPlan, null, 2) }}</pre>
          </details>
          <button :disabled="busy" @click="approveDrawing">
            Approve drawing program
          </button>
          <button
            class="secondary"
            :disabled="busy"
            @click="drawingPlan = undefined"
          >
            Discard drawing plan
          </button>
        </div>
        <h2>Desktop tasks</h2>
        <p v-if="!tasks.length" class="hint">
          Your tasks and their action history will appear here.
        </p>
        <button
          class="run"
          v-for="r in tasks"
          :key="r.id"
          :aria-pressed="selected === r.id"
          @click="selected = r.id"
        >
          <span>{{ r.contract.goal }}</span
          ><small
            >{{ labels[r.status] || r.status }} · {{ r.cursor }} actions</small
          >
        </button>
      </section>
      <section class="panel" v-if="current">
        <p class="eyebrow">
          {{
            current.contract.parameters.desktopScope === "computer"
              ? "This computer"
              : "One window"
          }}
          ·
          {{
            current.bindings.observation?.facts.windowTitle ||
            current.contract.parameters.windowTitle ||
            "Choose an app"
          }}
        </p>
        <h2>{{ current.contract.goal }}</h2>
        <p role="status" aria-live="polite">
          {{ labels[current.status] || current.status }}.
          {{ current.cursor }} of {{ current.contract.budgets.steps }} actions.
        </p>
        <p v-if="current.error" class="desktop-error">{{ current.error }}</p>
        <p class="assistant-message">{{ current.bindings.assistantMessage }}</p>
        <p
          v-if="current.bindings.observation?.facts.screenshotStatus"
          class="hint"
        >
          {{ current.bindings.observation.facts.screenshotStatus }}
        </p>
        <img
          v-if="image"
          :src="image"
          alt="Selected app at the latest desktop observation"
        />
        <div
          v-if="proposal && current.status === 'awaiting_approval'"
          class="desktop-review"
        >
          <h3>Proposed action</h3>
          <p>
            {{
              proposal.decision.operation === "switch_window"
                ? "Switch to"
                : proposal.decision.operation === "launch_app"
                  ? "Open"
                  : proposal.decision.operation
            }}<template v-if="targetControl">
              on
              {{
                targetControl.name || targetControl.id || "the selected control"
              }}</template
            >
          </p>
          <p v-if="navigationTarget">{{ navigationTarget }}</p>
          <pre v-if="proposal.decision.text !== undefined">{{
            proposal.decision.text
          }}</pre>
          <p v-if="proposal.decision.key">
            Key: <code>{{ proposal.decision.key }}</code>
          </p>
          <p v-if="proposal.decision.x !== undefined">
            Point {{ proposal.decision.x }}, {{ proposal.decision.y
            }}<template v-if="proposal.decision.dx !== undefined">
              to {{ proposal.decision.dx }},
              {{ proposal.decision.dy }}</template
            >
          </p>
          <p v-if="proposal.decision.amount">
            Scroll {{ proposal.decision.amount }} wheel units
          </p>
          <button :disabled="busy" @click="review('approve')">
            Approve this action
          </button>
          <p class="hint">
            Approval applies to this action only. If the app changes, the
            assistant will propose a new action.
          </p>
        </div>
        <div class="actions">
          <button
            v-if="
              ['queued', 'running', 'awaiting_approval'].includes(
                current.status,
              )
            "
            class="secondary"
            :disabled="busy"
            @click="control('pause')"
          >
            Pause task
          </button>
          <button
            v-if="current.status === 'paused'"
            class="secondary"
            :disabled="busy"
            @click="control('resume')"
          >
            Resume planning
          </button>
          <button
            v-if="current.status === 'reconciliation_required'"
            class="secondary"
            :disabled="busy"
            @click="control('reconcile')"
          >
            I have inspected the app
          </button>
          <button
            v-if="!['completed_by_user', 'cancelled'].includes(current.status)"
            class="danger"
            :disabled="busy"
            @click="control('cancel')"
          >
            Cancel task
          </button>
          <button
            v-if="
              ['needs_review', 'awaiting_input', 'blocked', 'paused'].includes(
                current.status,
              )
            "
            :disabled="busy"
            @click="review('confirm')"
          >
            Confirm task complete
          </button>
        </div>
        <p
          v-if="
            current.status === 'needs_review' &&
            current.contract.method.startsWith('drawing.')
          "
          class="hint"
        >
          Stroke execution and changed canvas pixels are verified. Check whether
          the drawing matches the requested subject.
        </p>
        <p v-else-if="current.status === 'needs_review'" class="hint">
          The model believes it has finished. Check the app before confirming.
          This is a model assessment, not an independently verified result.
        </p>
        <form
          v-if="
            ['needs_review', 'completed_by_user', 'paused'].includes(
              current.status,
            ) && current.bindings.observation?.facts.canvasImage
          "
          @submit.prevent="assessCanvas"
        >
          <label for="canvas-subject">Subject to check on the canvas</label>
          <input
            id="canvas-subject"
            v-model="subject"
            name="subject"
            required
            maxlength="100"
            placeholder="dog"
          />
          <button class="secondary" :disabled="busy">
            Assess canvas with selected vision providers
          </button>
          <p class="hint">
            The assessor reads the recorded target canvas. Its judgment stays
            separate from task completion.
          </p>
        </form>
        <div v-if="semantic?.assessment" role="status">
          <p>
            {{
              semantic.assessment.recognizable
                ? "Assessor recognizes the requested subject."
                : "Assessor did not recognize the requested subject."
            }}
            {{ semantic.assessment.reason }}
          </p>
          <details>
            <summary>Canvas assessment evidence</summary>
            <pre>{{ JSON.stringify(semantic, null, 2) }}</pre>
          </details>
        </div>
        <form
          v-if="
            [
              'awaiting_approval',
              'awaiting_input',
              'needs_review',
              'blocked',
              'paused',
            ].includes(current.status) &&
            current.contract.method === 'desktop.assistant'
          "
          @submit.prevent="review('continue')"
        >
          <label for="desktop-feedback"
            >Change the instruction or answer the assistant</label
          >
          <textarea
            id="desktop-feedback"
            name="feedback"
            v-model="feedback"
            required
            maxlength="4000"
            rows="2"
          ></textarea>
          <button class="secondary" :disabled="busy">
            Continue with this instruction
          </button>
        </form>
        <details v-if="current.bindings.providerResults">
          <summary>Model proposal sources and failures</summary>
          <ul>
            <li
              v-for="(member, index) in current.bindings.providerResults
                .members"
              :key="index"
            >
              {{ member.provider }} {{ member.model }} , {{ member.status
              }}<template v-if="member.reason">. {{ member.reason }}</template>
            </li>
          </ul>
          <p>
            Selection method:
            {{ current.bindings.providerResults.selectionMethod }}
          </p>
        </details>
        <details>
          <summary>Action history and evidence</summary>
          <ol>
            <li v-for="event in timeline" :key="event.seq">
              <details>
                <summary>
                  {{ new Date(event.at).toLocaleTimeString() }} ·
                  {{ event.type }}
                </summary>
                <pre>{{ JSON.stringify(event.data, null, 2) }}</pre>
              </details>
            </li>
          </ol>
        </details>
      </section>
      <section class="panel" v-else>
        <h2>Work across your desktop apps</h2>
        <p>
          Calculate a value and put it in a document. Open your file manager to
          find a file. Read an app's controls or draft text. Choose This
          computer to work across apps, or One window to keep the task in a
          single app.
        </p>
        <p>
          Keep the desktop session unlocked. Pause or use Take over before
          interacting with an app while an approved action is running.
        </p>
        <p>
          The assistant asks your selected providers for proposals. Models can
          make mistakes. Windows, macOS and Linux have native adapters. The
          available actions depend on OS permissions and the app's accessibility
          support. Terminals, password managers and security settings remain
          outside the supported app list.
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.desktop-intro {
  max-width: 850px;
}
.scope-picker {
  border: 1px solid #7b8475;
  border-radius: 8px;
  padding: 12px 16px;
  margin: 0;
}
.scope-picker label {
  margin: 8px 0;
}
.computer-status {
  color: #334830;
  font-size: 0.9rem;
}
.desktop-check {
  display: flex;
  align-items: center;
  gap: 10px;
}
.desktop-check input {
  width: 20px;
  min-width: 20px;
}
.desktop-review {
  border: 2px solid #587248;
  background: #f0f5e9;
  padding: 18px;
  border-radius: 8px;
  margin-block: 20px;
}
.desktop-review h3 {
  margin-top: 0;
}
.desktop-error {
  color: #852e23;
  white-space: pre-wrap;
}
.assistant-message {
  white-space: pre-wrap;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 350px;
  overflow: auto;
}
.actions {
  margin-top: 20px;
}
details {
  margin-top: 18px;
}
button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline: 3px solid #275b40;
  outline-offset: 3px;
}
</style>
