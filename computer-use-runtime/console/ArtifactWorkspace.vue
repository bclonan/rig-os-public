<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import type { RuntimeClient } from "../src/sdk/index";
const props = defineProps<{ client: RuntimeClient; caps: any }>();
const goal = ref(
  "Create the requested rows from this source and verify every value",
);
const sourceMode = ref("paste"),
  kind = ref("json_projection"),
  model = ref("");
const input = ref(
  '[{"name":"Alder","quantity":3},{"name":"Birch","quantity":7}]',
);
const sourceUrl = ref("");
const columns = ref(
  '[{"name":"name","source":"name"},{"name":"doubleQuantity","source":"quantity","transform":"number","multiply":2}]',
);
const runs = ref<any[]>([]),
  selected = ref(""),
  detail = ref<any>();
const busy = ref(false),
  error = ref(""),
  preview = ref("");
const models = computed(() => props.caps.providers?.models || []);
let timer: ReturnType<typeof setInterval>;
let closed = false;
let refreshVersion = 0,
  outputVersion = 0,
  selectionVersion = 0;
watch(
  [selected, () => props.client],
  () => {
    refreshVersion++;
    outputVersion++;
    selectionVersion++;
    detail.value = undefined;
    preview.value = "";
  },
  { flush: "sync" },
);
async function refresh() {
  const id = selected.value,
    client = props.client,
    version = ++refreshVersion;
  const current = () =>
    !closed &&
    id === selected.value &&
    client === props.client &&
    version === refreshVersion;
  try {
    const next = (await client.request("/api/tasks")).filter((run: any) =>
      run.contract.method?.startsWith("artifact."),
    );
    if (!current()) return;
    runs.value = next;
    if (id) {
      const result = await client.request(
        "/api/artifact-tasks/" + encodeURIComponent(id),
      );
      if (current()) detail.value = result;
    }
  } catch (e) {
    if (current()) error.value = String(e);
  }
}
async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  preview.value = "";
  const client = props.client,
    selection = selectionVersion;
  const current = () =>
    !closed && client === props.client && selection === selectionVersion;
  try {
    const source =
      sourceMode.value === "paste"
        ? {
            operation: "workspace_read",
            location:
              kind.value === "csv_transform" ? "input.csv" : "input.json",
          }
        : { operation: "research_read", location: sourceUrl.value };
    const result = await client.request("/api/artifact-tasks", "POST", {
      goal: goal.value,
      model: model.value,
      spec: {
        schemaVersion: 1,
        kind: kind.value,
        source,
        outputPath:
          kind.value === "csv_transform" ? "result.csv" : "result.json",
        columns: JSON.parse(columns.value),
      },
      ...(sourceMode.value === "paste" ? { input: input.value } : {}),
    });
    if (!current()) return;
    selected.value = result.id;
    await refresh();
  } catch (e) {
    if (current()) error.value = String(e);
  } finally {
    busy.value = false;
  }
}
async function control(command: string) {
  error.value = "";
  const id = selected.value,
    client = props.client,
    selection = selectionVersion;
  const current = () =>
    !closed &&
    client === props.client &&
    selection === selectionVersion &&
    id === selected.value;
  try {
    await client.control(id, command);
    if (!current()) return;
    await refresh();
  } catch (e) {
    if (current()) error.value = String(e);
  }
}
async function output(download: boolean) {
  error.value = "";
  const id = selected.value,
    client = props.client,
    version = ++outputVersion;
  const format = detail.value?.spec.kind;
  const current = () =>
    !closed &&
    id === selected.value &&
    client === props.client &&
    version === outputVersion;
  try {
    const { content } = await client.artifactOutput(id);
    if (!current()) return;
    preview.value = content;
    if (download) {
      const href = URL.createObjectURL(
        new Blob([content], {
          type: format === "csv_transform" ? "text/csv" : "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = href;
      link.download = format === "csv_transform" ? "result.csv" : "result.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    }
  } catch (e) {
    if (current()) error.value = String(e);
  }
}
onMounted(async () => {
  model.value = models.value[0]?.name || "";
  await refresh();
  if (closed) return;
  timer = setInterval(refresh, 2000);
});
onUnmounted(() => {
  closed = true;
  refreshVersion++;
  outputVersion++;
  clearInterval(timer);
});
</script>

<template>
  <div class="artifact-workspace">
    <section class="panel">
      <h2>Construct a verified artifact</h2>
      <p>
        The runtime reads your source, creates JSON or CSV with a local model,
        then checks every row and value against the criteria below. Failed
        checks can trigger up to two repairs.
      </p>
      <form action="/api/artifact-tasks" method="post" @submit.prevent="submit">
        <label for="artifact-goal">Request</label>
        <textarea
          id="artifact-goal"
          name="goal"
          v-model="goal"
          required
          maxlength="4000"
        />
        <label for="artifact-model">Local model</label>
        <select id="artifact-model" name="model" v-model="model" required>
          <option value="">Choose a model</option>
          <option v-for="item in models" :key="item.name" :value="item.name">
            {{ item.name }}
          </option>
        </select>
        <fieldset>
          <legend>Source</legend>
          <label
            ><input
              type="radio"
              name="source"
              v-model="sourceMode"
              value="paste"
            />
            Paste source data</label
          >
          <label
            ><input
              type="radio"
              name="source"
              v-model="sourceMode"
              value="web"
            />
            Read a public URL</label
          >
        </fieldset>
        <label v-if="sourceMode === 'paste'" for="artifact-input"
          >Source JSON or CSV</label
        >
        <textarea
          v-if="sourceMode === 'paste'"
          id="artifact-input"
          name="input"
          v-model="input"
          required
          maxlength="262144"
          rows="5"
        />
        <template v-else>
          <label for="artifact-url">Source URL</label>
          <input
            id="artifact-url"
            name="url"
            type="url"
            v-model="sourceUrl"
            required
            aria-describedby="artifact-url-help"
          />
          <p id="artifact-url-help" class="hint">
            The grant covers this URL's origin. Private network addresses,
            redirects, credentials and query strings are denied.
          </p>
        </template>
        <fieldset>
          <legend>Output format</legend>
          <label
            ><input
              type="radio"
              name="kind"
              v-model="kind"
              value="json_projection"
            />
            JSON rows</label
          >
          <label
            ><input
              type="radio"
              name="kind"
              v-model="kind"
              value="csv_transform"
            />
            CSV rows</label
          >
        </fieldset>
        <label for="artifact-columns">Output columns and calculations</label>
        <textarea
          id="artifact-columns"
          name="columns"
          v-model="columns"
          required
          rows="5"
          aria-describedby="artifact-columns-help"
        />
        <p id="artifact-columns-help" class="hint">
          Each column has a name and source field. Optional transforms are
          identity, uppercase and number. Multiply applies a number calculation.
          These criteria freeze when you start.
        </p>
        <button type="submit" :disabled="busy">
          {{ busy ? "Submitting" : "Construct and verify" }}
        </button>
      </form>
      <p role="alert" v-if="error" class="error">{{ error }}</p>
    </section>
    <section class="panel">
      <h2>Artifact tasks</h2>
      <p v-if="!runs.length">
        Submitted tasks and their verification attempts appear here.
      </p>
      <button
        v-for="run in runs"
        :key="run.id"
        class="secondary"
        @click="
          selected = run.id;
          preview = '';
          refresh();
        "
      >
        {{ run.contract.goal }} , {{ run.status }}
      </button>
      <template v-if="detail">
        <h3>{{ detail.run.status }}</h3>
        <p v-if="detail.run.error" role="status">{{ detail.run.error }}</p>
        <div class="actions">
          <button
            v-if="
              detail.run.status === 'running' || detail.run.status === 'queued'
            "
            @click="control('pause')"
          >
            Pause
          </button>
          <button
            v-if="detail.run.status === 'paused'"
            @click="control('resume')"
          >
            Resume
          </button>
          <button
            v-if="detail.run.status === 'reconciliation_required'"
            @click="control('reconcile')"
          >
            Reconcile from evidence
          </button>
          <button
            v-if="!['succeeded', 'cancelled'].includes(detail.run.status)"
            @click="control('cancel')"
          >
            Cancel
          </button>
          <button
            v-if="detail.run.status === 'succeeded'"
            @click="output(false)"
          >
            Preview verified output
          </button>
          <button
            v-if="detail.run.status === 'succeeded'"
            @click="output(true)"
          >
            Download verified output
          </button>
        </div>
        <p role="status">
          {{
            detail.state?.verification?.diff ||
            "Waiting for independent verification"
          }}
        </p>
        <pre v-if="preview">{{ preview }}</pre>
        <details>
          <summary>Frozen criteria and source hashes</summary>
          <pre>{{
            JSON.stringify(
              { criteria: detail.spec, state: detail.state },
              null,
              2,
            )
          }}</pre>
        </details>
        <details v-for="attempt in detail.attempts" :key="attempt.id">
          <summary>
            {{ attempt.kind }} ,
            {{ attempt.verification.valid ? "verified" : "failed" }}
          </summary>
          <pre>{{ JSON.stringify(attempt, null, 2) }}</pre>
        </details>
      </template>
    </section>
  </div>
</template>

<style scoped>
.artifact-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 24px;
}
fieldset {
  margin-block: 16px;
  border: 1px solid #bfcac2;
}
fieldset label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-inline-end: 16px;
}
fieldset input {
  width: auto;
}
textarea {
  min-height: 80px;
  resize: vertical;
}
pre {
  max-height: 420px;
  overflow: auto;
}
@media (max-width: 900px) {
  .artifact-workspace {
    grid-template-columns: 1fr;
  }
}
</style>
