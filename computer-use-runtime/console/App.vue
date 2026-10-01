<script setup lang="ts">
import { ref, computed, onUnmounted, nextTick, watch } from "vue";
import { RuntimeClient } from "../src/sdk/index";
import DesktopWorkspace from "./DesktopWorkspace.vue";
import ArtifactWorkspace from "./ArtifactWorkspace.vue";
const savedToken = (() => {
  try {
    return sessionStorage.getItem("runtime-token") || "";
  } catch {
    return "";
  }
})();
const token = ref(savedToken),
  connected = ref(false),
  showToken = ref(false),
  connectionMessage = ref(""),
  error = ref(""),
  caps = ref<any>({}),
  runs = ref<any[]>([]),
  skills = ref<any[]>([]),
  events = ref<any[]>([]),
  models = ref<any[]>([]),
  results = ref<any>(),
  jobs = ref<any[]>([]),
  demonstrations = ref<any[]>([]),
  demonstrationIds = ref<string[]>([]),
  history = ref<any[]>([]);
const goal = ref("Set the display name to Willow 851"),
  name = ref("Willow 851"),
  provider = ref("structured"),
  selected = ref(""),
  recorded = ref<any>(),
  image = ref(""),
  imageLabel = ref("Live fixture"),
  busy = ref(false),
  tab = ref("Desktop");
const tabs = [
  "Desktop",
  "Artifacts",
  "Runs",
  "Skills",
  "Learning",
  "Evaluation",
];
function readTab() {
  tab.value =
    tabs.find((item) => item.toLowerCase() === location.hash.slice(1)) ||
    "Desktop";
}
readTab();
window.addEventListener("hashchange", readTab);
watch(tab, (value) => {
  location.hash = value.toLowerCase();
});
const selectedRun = computed(() =>
  runs.value.find((run) => run.id === selected.value),
);
const advice = ref<any>();
let adviceVersion = 0,
  historyVersion = 0,
  imageVersion = 0,
  refreshVersion = 0,
  selectionVersion = 0;
async function assessOwnedState() {
  const id = selected.value,
    epoch = connectionEpoch,
    version = ++adviceVersion;
  try {
    const result = await client.advice(id);
    if (
      epoch === connectionEpoch &&
      id === selected.value &&
      version === adviceVersion
    )
      advice.value = result;
  } catch (e) {
    if (
      epoch === connectionEpoch &&
      id === selected.value &&
      version === adviceVersion
    )
      throw e;
  }
}
watch(
  selected,
  () => {
    adviceVersion++;
    historyVersion++;
    imageVersion++;
    selectionVersion++;
    advice.value = undefined;
    history.value = [];
  },
  { flush: "sync" },
);
const finished = computed(() =>
  ["succeeded", "cancelled", "completed_by_user"].includes(
    selectedRun.value?.status,
  ),
);
let connectionEpoch = 0,
  disposed = false;
watch(selected, async (id) => {
  history.value = [];
  if (!id || !client) return;
  const epoch = connectionEpoch;
  const version = ++historyVersion;
  try {
    const evidence = await client.request(
      "/api/tasks/" + encodeURIComponent(id) + "/evidence",
    );
    if (
      epoch === connectionEpoch &&
      selected.value === id &&
      version === historyVersion
    )
      history.value = evidence;
  } catch (e) {
    if (
      epoch === connectionEpoch &&
      selected.value === id &&
      version === historyVersion
    )
      error.value = String(e);
  }
});
let client: RuntimeClient,
  abort: AbortController,
  timer: ReturnType<typeof setInterval>;
let refreshPending = false;
function stopUpdates() {
  connectionEpoch++;
  adviceVersion++;
  historyVersion++;
  imageVersion++;
  refreshVersion++;
  refreshPending = false;
  abort?.abort();
  clearInterval(timer);
}
async function disconnect(
  message = "Disconnected. The runtime is still running.",
  forget = false,
) {
  stopUpdates();
  connected.value = false;
  connectionMessage.value = message;
  showToken.value = false;
  if (forget) {
    token.value = "";
    try {
      sessionStorage.removeItem("runtime-token");
    } catch {}
  }
  await nextTick();
  document.getElementById("token")?.focus();
}
const selectedEvents = computed(() => {
  const bySequence = new Map(
    [...history.value, ...events.value]
      .filter((e) => !selected.value || e.runId === selected.value)
      .map((e) => [e.seq, e]),
  );
  return [...bySequence.values()].sort((a, b) => a.seq - b.seq);
});
const metrics = computed(() => ({
  actions: selectedEvents.value.filter((e) => e.type === "dispatched").length,
  observations: selectedEvents.value.filter(
    (e) => e.type === "observation" || e.type === "verification",
  ).length,
  dispatchMs: Math.round(
    selectedEvents.value
      .filter((e) => e.type === "acknowledged")
      .reduce((n, e) => n + (e.data.timings?.dispatchMs || 0), 0),
  ),
  modelCalls: selectedEvents.value.filter(
    (e) => e.type === "controller_prediction",
  ).length,
}));
async function replay(hash: string) {
  const epoch = connectionEpoch,
    id = selected.value,
    version = ++imageVersion;
  const response = await fetch("/api/artifacts/" + encodeURIComponent(hash), {
    headers: { authorization: "Bearer " + token.value },
  });
  if (
    epoch !== connectionEpoch ||
    id !== selected.value ||
    version !== imageVersion
  )
    return;
  if (!response.ok) throw new Error("Replay image unavailable");
  const blob = await response.blob();
  if (
    epoch !== connectionEpoch ||
    id !== selected.value ||
    version !== imageVersion
  )
    return;
  if (image.value) URL.revokeObjectURL(image.value);
  image.value = URL.createObjectURL(blob);
  imageLabel.value = "Recorded observation";
  tab.value = "Runs";
}
async function act(fn: () => Promise<any>) {
  if (busy.value) return;
  error.value = "";
  busy.value = true;
  const selection = selectionVersion;
  try {
    const result = await fn();
    if (connected.value) await refresh();
    return result;
  } catch (e) {
    if (selection === selectionVersion) error.value = String(e);
  } finally {
    busy.value = false;
  }
}
async function refresh() {
  const epoch = connectionEpoch,
    version = ++refreshVersion;
  const [nextRuns, nextSkills, nextModels, nextJobs, nextCaps, recordings] =
    await Promise.all([
      client.request("/api/tasks"),
      client.request("/api/skills"),
      client.request("/api/models"),
      client.request("/api/jobs"),
      client.request("/api/capabilities"),
      client.request("/api/record"),
    ]);
  if (epoch !== connectionEpoch || version !== refreshVersion) return;
  runs.value = nextRuns;
  skills.value = nextSkills;
  models.value = nextModels;
  jobs.value = nextJobs;
  caps.value = nextCaps;
  demonstrations.value = recordings.demonstrations;
  if (recorded.value)
    recorded.value = demonstrations.value.find(
      (d) => d.id === recorded.value.id,
    );
  demonstrationIds.value = demonstrationIds.value.filter((id) =>
    demonstrations.value.some((d) => d.id === id && d.verified),
  );
}
function downloadSkill(skill: any) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(skill, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = skill.id + ".json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function connect() {
  await act(async () => {
    stopUpdates();
    const epoch = connectionEpoch;
    token.value = token.value.trim();
    client = new RuntimeClient(location.origin, token.value);
    try {
      const result = await client.request("/api/capabilities");
      if (disposed || epoch !== connectionEpoch) return;
      caps.value = result;
      await refresh();
      await capture();
    } catch (error) {
      if (disposed || epoch !== connectionEpoch) return;
      connectionMessage.value =
        "Start the runtime with npm start, then check your token with npm run token.";
      throw error;
    }
    if (disposed || epoch !== connectionEpoch) return;
    events.value = [];
    try {
      sessionStorage.setItem("runtime-token", token.value);
    } catch {}
    connected.value = true;
    connectionMessage.value = "";
    abort = new AbortController();
    void stream(abort.signal);
    timer = setInterval(async () => {
      if (refreshPending || !connected.value) return;
      const epoch = connectionEpoch;
      refreshPending = true;
      try {
        await refresh();
      } catch {
        if (epoch === connectionEpoch && connected.value)
          await disconnect(
            "Connection lost. Run npm start, then reconnect. Your saved tasks remain on this machine.",
          );
      } finally {
        if (epoch === connectionEpoch) refreshPending = false;
      }
    }, 2000);
  });
}
async function stream(signal: AbortSignal) {
  try {
    for await (const e of client.events(0, signal)) {
      if (signal.aborted) break;
      events.value = [...events.value.slice(-499), e];
    }
  } catch (e) {
    if (!signal.aborted) error.value = String(e);
  }
}
async function shutdown() {
  await act(async () => {
    await client.request("/api/service/shutdown", "POST", {});
    await disconnect(
      "Shutdown requested. The runtime is pausing tasks and closing its workers. Run npm start to use it again.",
    );
  });
}
async function capture() {
  const epoch = connectionEpoch,
    id = selected.value,
    version = ++imageVersion;
  const o = await client.request("/api/observation");
  if (
    epoch !== connectionEpoch ||
    id !== selected.value ||
    version !== imageVersion
  )
    return;
  if (o.image) {
    const response = await fetch(
      "/api/artifacts/" + encodeURIComponent(o.image),
      {
        headers: { authorization: "Bearer " + token.value },
      },
    );
    if (
      epoch !== connectionEpoch ||
      id !== selected.value ||
      version !== imageVersion
    )
      return;
    if (!response.ok) throw new Error("Observation image unavailable");
    const blob = await response.blob();
    if (
      epoch !== connectionEpoch ||
      id !== selected.value ||
      version !== imageVersion
    )
      return;
    if (image.value) URL.revokeObjectURL(image.value);
    image.value = URL.createObjectURL(blob);
    imageLabel.value = "Live fixture";
  }
}
async function submit() {
  await act(async () => {
    const epoch = connectionEpoch,
      selection = selectionVersion,
      owner = client;
    let task;
    if (provider.value === "structured") {
      const id = crypto.randomUUID();
      task = {
        schemaVersion: 1,
        id,
        correlationId: crypto.randomUUID(),
        requester: "local-user",
        goal: goal.value,
        target: {
          host: caps.value.host,
          session: caps.value.session,
          identity: caps.value.identity,
        },
        parameters: { name: name.value },
        effects: ["edit"],
        requirements: [
          { name: "name", value: name.value, origin: "user_explicit" },
        ],
        unresolved: [],
        method: "auto",
        expected: { result: name.value },
        budgets: { steps: 8, deadlineMs: 15000 },
      };
    } else
      task = await client.request("/api/intent", "POST", {
        goal: goal.value,
        model: provider.value,
      });
    const run = await client.submit(task);
    if (
      epoch !== connectionEpoch ||
      selection !== selectionVersion ||
      owner !== client
    )
      return;
    selected.value = run.id;
    await refresh();
  });
}
async function control(command: string) {
  await act(async () => {
    await client.control(selected.value, command);
    await refresh();
    await capture();
  });
}
async function record() {
  await act(async () => {
    const id = selected.value,
      epoch = connectionEpoch,
      selection = selectionVersion;
    const result = await client.request("/api/record", "POST", {
      runId: id,
    });
    if (
      epoch !== connectionEpoch ||
      id !== selected.value ||
      selection !== selectionVersion
    )
      return;
    recorded.value = result;
    tab.value = "Learning";
  });
}
onUnmounted(() => {
  disposed = true;
  stopUpdates();
  window.removeEventListener("hashchange", readTab);
  if (image.value) URL.revokeObjectURL(image.value);
});
</script>
<template>
  <header>
    <div class="brand">CR<span>Computer use runtime</span></div>
    <span class="pill">{{ connected ? "Connected" : "Not connected" }}</span>
  </header>
  <main>
    <section v-if="!connected" class="login">
      <p class="eyebrow">Standalone control console</p>
      <h1>Connect to your local runtime</h1>
      <p id="token-help">
        In the running terminal, type <code>token</code> and press Enter to see
        your login token. Or run <code>npm run token -- --copy</code> in another
        terminal, then paste below.
      </p>
      <p class="hint">
        This tab remembers the token until you disconnect or close the tab.
      </p>
      <p role="status">{{ connectionMessage }}</p>
      <form @submit.prevent="connect">
        <label for="token">Local service token</label
        ><input
          id="token"
          :type="showToken ? 'text' : 'password'"
          v-model="token"
          required
          autocomplete="off"
          aria-describedby="token-help"
          spellcheck="false"
        />
        <button
          type="button"
          class="secondary"
          :aria-pressed="showToken"
          aria-controls="token"
          @click="showToken = !showToken"
        >
          {{ showToken ? "Hide token" : "Show token" }}
        </button>
        <button :disabled="busy">
          {{
            token && (savedToken || connectionMessage) ? "Reconnect" : "Connect"
          }}
        </button>
      </form>
    </section>
    <template v-else>
      <div class="workspace-head">
        <div>
          <p class="eyebrow">{{ caps.host }} / {{ caps.session }}</p>
          <h1>Desktop assistant</h1>
          <p>
            Choose models for your desktop task and review their proposed
            actions. External providers require your permission to receive task
            content.
          </p>
        </div>
        <div class="actions">
          <button
            class="secondary"
            :disabled="busy"
            @click="disconnect(undefined, true)"
          >
            Disconnect
          </button>
          <button class="danger" :disabled="busy" @click="shutdown">
            Shut down runtime
          </button>
          <button
            class="secondary"
            :disabled="busy"
            @click="act(() => client.request('/api/takeover', 'POST', {}))"
          >
            Take over</button
          ><button
            class="secondary"
            :disabled="busy"
            @click="act(() => client.request('/api/return', 'POST', {}))"
          >
            Return control
          </button>
        </div>
      </div>
      <nav aria-label="Workspace">
        <button
          v-for="item in tabs"
          :aria-current="tab === item ? 'page' : undefined"
          :key="item"
          :class="{ active: tab === item }"
          @click="tab = item"
        >
          {{ item }}
        </button>
      </nav>
      <DesktopWorkspace
        v-if="tab === 'Desktop'"
        :client="client"
        :runs="runs"
        :providers="caps.providers"
        :token="token"
        @refresh="act(refresh)"
      />
      <ArtifactWorkspace
        v-if="tab === 'Artifacts'"
        :client="client"
        :caps="caps"
      />
      <div v-if="tab === 'Runs'" class="grid">
        <section class="panel">
          <h2>Browser fixture task</h2>
          <form @submit.prevent="submit">
            <label for="goal">Goal</label
            ><textarea id="goal" v-model="goal" required rows="3"></textarea
            ><label for="provider">Compiler</label
            ><select id="provider" v-model="provider">
              <option value="structured">Structured form contract</option>
              <option v-for="m in caps.providers.models" :value="m.name">
                {{ m.name }} · local language model
              </option></select
            ><label v-if="provider === 'structured'" for="name"
              >Display name</label
            ><input
              v-if="provider === 'structured'"
              id="name"
              v-model="name"
              required
            />
            <p class="hint">
              Authorized effect is editing the disposable local form.
            </p>
            <button :disabled="busy">Run task</button>
          </form>
          <h2>Recent runs</h2>
          <p v-if="!runs.length" class="hint">
            No tasks yet. Run the form task to inspect its evidence.
          </p>
          <button
            class="run"
            v-for="r in runs.slice().reverse()"
            :key="r.id"
            @click="selected = r.id"
          >
            <span>{{ r.contract.goal }}</span
            ><small :class="r.status"
              >{{ r.status }} · step {{ r.cursor }}</small
            >
          </button>
        </section>
        <section class="panel">
          <div class="row">
            <h2>{{ imageLabel }}</h2>
            <button class="secondary" @click="act(capture)">Refresh</button>
          </div>
          <img
            v-if="image"
            :src="image"
            :alt="imageLabel + ' of the disposable browser workbench'"
          />
          <div class="actions" v-if="selected">
            <button
              class="secondary"
              :disabled="busy || finished || selectedRun?.status === 'paused'"
              @click="control('pause')"
            >
              Pause</button
            ><button
              class="secondary"
              :disabled="busy || selectedRun?.status !== 'paused'"
              @click="control('resume')"
            >
              Resume</button
            ><button
              class="secondary"
              :disabled="busy || finished"
              @click="control('reconcile')"
            >
              Reconcile</button
            ><button
              class="danger"
              :disabled="busy || finished"
              @click="control('cancel')"
            >
              Cancel</button
            ><button :disabled="busy" @click="record">Record run</button>
            <button
              class="secondary"
              :disabled="busy"
              @click="act(assessOwnedState)"
            >
              Read owned model advice
            </button>
          </div>
          <div v-if="advice" role="status">
            <p v-if="!advice.available">{{ advice.reason }}</p>
            <template v-else>
              <p>
                Owned model {{ advice.model }} recommends
                {{ advice.advice.recovery }}. These predictions do not authorize
                input or verify completion.
              </p>
              <p v-if="advice.advice.clarificationRecommended">
                The model recommends clarifying the task.
              </p>
              <details>
                <summary>Prediction evidence</summary>
                <pre>{{ JSON.stringify(advice, null, 2) }}</pre>
              </details>
            </template>
          </div>
          <p class="hint">
            {{ metrics.actions }} actions ·
            {{ metrics.observations }} observations ·
            {{ metrics.dispatchMs }} ms dispatch ·
            {{ metrics.modelCalls }} owned model calls
          </p>
          <h2>Action and evidence timeline</h2>
          <div class="timeline">
            <details
              v-for="e in selectedEvents.slice(-500).reverse()"
              :key="e.seq"
            >
              <summary>
                <time>{{ new Date(e.at).toLocaleTimeString() }}</time>
                {{ e.type }} <small>#{{ e.seq }}</small>
              </summary>
              <button
                v-if="e.data.observation?.image"
                class="secondary"
                @click="act(() => replay(e.data.observation.image))"
              >
                Replay observation
              </button>
              <pre>{{ JSON.stringify(e.data, null, 2) }}</pre>
            </details>
          </div>
        </section>
      </div>
      <section v-if="tab === 'Skills'" class="panel">
        <h2>Skill registry</h2>
        <p>
          Imported skills enter quarantine. Content hashes do not grant
          execution permission.
        </p>
        <details v-for="s in skills" :key="s.hash">
          <summary>
            {{ s.id }} · {{ s.status }} · {{ s.provenance.kind }}
          </summary>
          <pre>{{ JSON.stringify(s, null, 2) }}</pre>
          <button
            v-if="s.status === 'draft' || s.status === 'quarantined'"
            class="secondary"
            :disabled="busy"
            @click="
              act(async () => {
                await client.request(
                  '/api/skills/' + encodeURIComponent(s.id) + '/test',
                  'POST',
                  {},
                );
                await refresh();
              })
            "
          >
            Test candidate and publish if it passes</button
          ><button class="secondary" @click="downloadSkill(s)">
            Export capsule
          </button>
        </details>
        <h3>Demonstrations to compile</h3>
        <p v-if="!demonstrations.length">
          Record three successful fixture runs with different names first.
        </p>
        <label
          v-for="demo in demonstrations"
          :key="demo.id"
          class="demo-choice"
        >
          <input
            type="checkbox"
            v-model="demonstrationIds"
            :value="demo.id"
            :disabled="!demo.verified || busy"
          />
          {{ demo.contract.parameters.name || demo.contract.goal }} ,
          {{ demo.verified ? "verified" : "needs correction" }}
        </label>
        <button
          :disabled="busy || demonstrationIds.length < 3"
          @click="
            act(async () => {
              await client.request('/api/compile', 'POST', {
                demonstrationIds,
              });
              await refresh();
            })
          "
        >
          Compile recorded demonstrations
        </button>
        <button
          class="secondary"
          :disabled="busy || demonstrationIds.length < 6"
          @click="
            act(async () => {
              await client.request('/api/compile', 'POST', {
                demonstrationIds,
                library: true,
              });
              await refresh();
            })
          "
        >
          Extract shared subskills across methods
        </button>
      </section>
      <section v-if="tab === 'Learning'" class="panel">
        <h2>Owned controller</h2>
        <p>
          Active model: {{ caps.activeModel }}. Training uses controlled fixture
          data. Native desktop learning is unverified.
        </p>
        <div class="actions">
          <button
            :disabled="busy"
            @click="
              act(() => client.request('/api/jobs', 'POST', { type: 'train' }))
            "
          >
            Train three seeds</button
          ><button
            @click="
              act(() =>
                client.request('/api/jobs', 'POST', {
                  type: 'train-recordings',
                }),
              )
            "
          >
            Train from recorded experience</button
          ><button
            @click="
              act(() =>
                client.request('/api/jobs', 'POST', { type: 'verify-audit' }),
              )
            "
          >
            Verify frozen audit</button
          ><button
            class="secondary"
            :disabled="busy"
            @click="
              act(() => client.request('/api/models/rollback', 'POST', {}))
            "
          >
            Roll back model
          </button>
        </div>
        <div v-for="m in models">
          <p>
            ONNX parity:
            {{ m.metrics.parity < 0 ? "Unverified" : m.metrics.parity }}
          </p>
          <pre>{{ m }}</pre>
          <button
            class="secondary"
            :disabled="busy"
            @click="
              act(async () => {
                await client.request('/api/models/activate', 'POST', {
                  id: m.id,
                });
                caps.activeModel = m.id;
                await refresh();
              })
            "
          >
            Activate audited model
          </button>
        </div>
        <details v-for="job in jobs">
          <summary>{{ job.type }} · {{ job.status }}</summary>
          <pre>{{ job.output }}</pre>
        </details>
        <label for="recording">Recorded demonstration</label>
        <select
          id="recording"
          :value="recorded?.id || ''"
          @change="
            recorded = demonstrations.find(
              (d) => d.id === ($event.target as HTMLSelectElement).value,
            )
          "
        >
          <option value="">Choose a recording</option>
          <option
            v-for="demo in demonstrations"
            :key="demo.id"
            :value="demo.id"
          >
            {{ demo.contract.goal }} , {{ demo.id.slice(0, 8) }}
          </option>
        </select>
        <div v-if="recorded">
          <h2>Recorded demonstration</h2>
          <p>{{ recorded.id }} · {{ recorded.steps.length }} steps</p>
          <button
            class="secondary"
            :disabled="busy"
            @click="
              act(() =>
                client.request('/api/correct', 'POST', {
                  id: recorded.id,
                  step: 0,
                  label: 'failure',
                }),
              )
            "
          >
            Mark first step incorrect
          </button>
          <pre>{{ recorded }}</pre>
        </div>
      </section>
      <section v-if="tab === 'Evaluation'" class="panel">
        <div class="row">
          <h2>Frozen audit results</h2>
          <button
            :disabled="busy"
            @click="
              act(async () => (results = await client.request('/api/results')))
            "
          >
            Load results
          </button>
        </div>
        <p>
          PASS, FAIL, BLOCKED, NOT RUN and UNVERIFIED remain separate. Browser
          fixtures do not establish Microsoft Paint or remote-host performance.
        </p>
        <pre v-if="results">{{ JSON.stringify(results, null, 2) }}</pre>
      </section>
    </template>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
  </main>
  <footer>
    Computer use runtime 0.1 · No mandatory cloud provider · Permission checks
    remain outside the model
  </footer>
</template>
