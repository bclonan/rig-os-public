<script lang="ts">
export type ProviderName = "ollama" | "codex-cli" | "claude-cli";
export type ModelSelection = {
  providers: { provider: ProviderName; model: string }[];
  strategy: "fallback" | "ensemble";
  allowRemote: boolean;
  model: string;
};
type Choice = {
  provider: ProviderName;
  model: string;
  name: string;
  available: boolean;
  local: boolean;
  reason?: string;
  modalities?: string[];
};
</script>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

const props = defineProps<{
  idPrefix: string;
  providers: unknown;
  modelValue: ModelSelection;
  screenshots?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [value: ModelSelection] }>();
const picker = ref<HTMLFieldSetElement>();
const picked = ref<string[]>([]);
const custom = ref<Choice[]>([]);
const customProvider = ref<ProviderName>("ollama");
const customModel = ref("");
const strategy = ref<ModelSelection["strategy"]>("fallback");
const allowRemote = ref(false);
const error = ref("");
const providerNames: Record<ProviderName, string> = {
  ollama: "Ollama",
  "codex-cli": "Codex CLI",
  "claude-cli": "Claude CLI",
};
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function key(choice: Pick<Choice, "provider" | "model">) {
  return JSON.stringify([choice.provider, choice.model]);
}
function choiceName(choice: Choice) {
  const provider = providerNames[choice.provider];
  return choice.name.startsWith(provider)
    ? choice.name
    : `${provider} ${choice.name}`;
}
const discovered = computed<Choice[]>(() => {
  const data = object(props.providers);
  if (Array.isArray(data.choices))
    return data.choices.flatMap((raw) => {
      const item = object(raw);
      if (
        !["ollama", "codex-cli", "claude-cli"].includes(
          String(item.provider),
        ) ||
        typeof item.model !== "string" ||
        !item.model.trim()
      )
        return [];
      return [
        {
          provider: item.provider as ProviderName,
          model: item.model,
          name: typeof item.name === "string" ? item.name : item.model,
          available: item.available === true,
          local: item.local === true,
          reason: typeof item.reason === "string" ? item.reason : undefined,
          modalities: Array.isArray(item.modalities)
            ? item.modalities.filter(
                (value): value is string => typeof value === "string",
              )
            : undefined,
        },
      ];
    });
  return Array.isArray(data.models)
    ? data.models.flatMap((raw) => {
        const item = object(raw);
        return typeof item.name === "string"
          ? [
              {
                provider: "ollama" as const,
                model: item.name,
                name: item.name,
                available: data.available !== false,
                local: true,
              },
            ]
          : [];
      })
    : [];
});
const choices = computed(() => {
  const unique = new Map<string, Choice>();
  for (const choice of [...custom.value, ...discovered.value])
    unique.set(key(choice), choice);
  return [...unique.values()];
});
const selected = computed(() =>
  picked.value.flatMap((id) => {
    const choice = choices.value.find((item) => key(item) === id);
    return choice ? [choice] : [];
  }),
);
const remote = computed(() => selected.value.filter((choice) => !choice.local));
const selectedNames = computed(() =>
  selected.value
    .map((choice) => `${providerNames[choice.provider]} ${choice.model}`)
    .join(", "),
);
const unsupportedVision = computed(() =>
  selected.value.filter(
    (choice) =>
      choice.modalities &&
      !choice.modalities.some((modality) =>
        ["image", "vision"].includes(modality),
      ),
  ),
);
function publish() {
  const value: ModelSelection = {
    providers: selected.value.map(({ provider, model }) => ({
      provider,
      model,
    })),
    strategy: strategy.value,
    allowRemote: remote.value.length > 0 && allowRemote.value,
    model:
      selected.value.find((choice) => choice.provider === "ollama")?.model ||
      "",
  };
  if (JSON.stringify(value) !== JSON.stringify(props.modelValue))
    emit("update:modelValue", value);
}
watch(
  discovered,
  () => {
    if (!picked.value.length) {
      const first = choices.value.find(
        (choice) => choice.provider === "ollama" && choice.available,
      );
      if (first) picked.value = [key(first)];
    }
    publish();
  },
  { immediate: true },
);
watch(
  [
    () =>
      JSON.stringify(
        selected.value.map(({ provider, model, local }) => ({
          provider,
          model,
          local,
        })),
      ),
    () => props.screenshots,
  ],
  () => {
    allowRemote.value = false;
    error.value = "";
    publish();
  },
  { deep: true },
);
watch([strategy, allowRemote], publish);
function toggle(choice: Choice) {
  const id = key(choice);
  picked.value = picked.value.includes(id)
    ? picked.value.filter((value) => value !== id)
    : [...picked.value, id];
}
function addCustom() {
  const model =
    customModel.value.trim() ||
    (customProvider.value === "ollama" ? "" : "default");
  if (!model || model.length > 200) {
    error.value = "Enter a model name of at most 200 characters.";
    return;
  }
  if (picked.value.length >= 4) {
    error.value =
      "Remove a selected model before adding another. The limit is four.";
    return;
  }
  const known = discovered.value.find(
    (item) => item.provider === customProvider.value && item.model === model,
  );
  const provider = discovered.value.find(
    (item) => item.provider === customProvider.value,
  );
  const data = object(props.providers);
  const choice: Choice = known || {
    provider: customProvider.value,
    model,
    name: model,
    available:
      provider?.available ??
      (customProvider.value === "ollama" &&
        data.available !== false &&
        Array.isArray(data.models)),
    local: customProvider.value === "ollama",
    reason:
      provider?.reason ||
      "Start this provider and reconnect to check availability.",
  };
  if (!choice.available) {
    error.value = `${providerNames[choice.provider]} is unavailable. ${choice.reason || "Install it and reconnect."}`;
    return;
  }
  if (!choices.value.some((item) => key(item) === key(choice)))
    custom.value.push(choice);
  if (!picked.value.includes(key(choice)))
    picked.value = [...picked.value, key(choice)];
  customModel.value = "";
  error.value = "";
}
function validate(requireVision = props.screenshots === true) {
  error.value =
    selected.value.length === 0
      ? "Choose at least one model."
      : selected.value.length > 4
        ? "Choose at most four models."
        : selected.value.some((choice) => !choice.available)
          ? "A selected provider is unavailable. Remove it or reconnect after starting it."
          : remote.value.length && !allowRemote.value
            ? "Confirm remote-provider consent before continuing."
            : requireVision && unsupportedVision.value.length
              ? `Screenshots are unsupported by ${unsupportedVision.value.map((choice) => choice.model).join(", ")}. Choose a vision model or turn screenshots off.`
              : "";
  if (error.value) void nextTick(() => picker.value?.focus());
  return !error.value;
}
defineExpose({ validate });
</script>

<template>
  <fieldset
    ref="picker"
    :id="idPrefix + '-model'"
    class="model-picker"
    tabindex="-1"
    :aria-describedby="idPrefix + '-model-help'"
  >
    <legend>Models and providers</legend>
    <p :id="idPrefix + '-model-help'" class="hint">
      Choose one to four models. Fallback tries them in selection order.
      Parallel evaluation asks each selected model for a proposal. If valid
      proposals disagree, it may make one extra model call to choose between
      them. You still review every action.
    </p>
    <p v-if="!choices.length" class="hint">
      No models discovered. Start Ollama or install a supported CLI provider,
      then reconnect.
    </p>
    <div
      v-for="(choice, index) in choices"
      :key="key(choice)"
      class="provider-row"
    >
      <label :for="idPrefix + '-provider-' + index">
        <input
          :id="idPrefix + '-provider-' + index"
          :name="idPrefix + '-providers'"
          type="checkbox"
          :checked="picked.includes(key(choice))"
          :disabled="
            !picked.includes(key(choice)) &&
            (!choice.available || picked.length >= 4)
          "
          :aria-describedby="idPrefix + '-provider-status-' + index"
          @change="toggle(choice)"
        />
        <span>{{ choiceName(choice) }}</span>
      </label>
      <p :id="idPrefix + '-provider-status-' + index" class="hint">
        {{
          choice.available
            ? choice.local
              ? "Local"
              : "May send data to a remote provider"
            : "Unavailable"
        }}<template v-if="!choice.available"
          >.
          {{
            choice.reason || "Install or start this provider and reconnect."
          }}</template
        >
      </p>
    </div>
    <p class="hint">
      {{ picked.length }} of 4 selected<template v-if="selectedNames"
        >. Order: {{ selectedNames }}</template
      >
    </p>
    <details>
      <summary>Add a custom model or CLI model</summary>
      <label :for="idPrefix + '-custom-provider'">Provider</label>
      <select
        :id="idPrefix + '-custom-provider'"
        :name="idPrefix + '-custom-provider'"
        v-model="customProvider"
      >
        <option value="ollama">Ollama</option>
        <option value="codex-cli">Codex CLI</option>
        <option value="claude-cli">Claude CLI</option>
      </select>
      <label :for="idPrefix + '-custom-model'">Model name</label>
      <input
        :id="idPrefix + '-custom-model'"
        :name="idPrefix + '-custom-model'"
        v-model="customModel"
        maxlength="200"
        autocomplete="off"
        :aria-describedby="idPrefix + '-custom-help'"
        @input="error = ''"
      />
      <p :id="idPrefix + '-custom-help'" class="hint">
        Use an installed Ollama model name or a model accepted by your CLI. An
        empty CLI model uses its default. The server checks model support before
        generation.
      </p>
      <button type="button" class="secondary" @click="addCustom">
        Add model
      </button>
    </details>
    <fieldset class="strategy-picker">
      <legend>How to use the selected models</legend>
      <label :for="idPrefix + '-fallback'"
        ><input
          :id="idPrefix + '-fallback'"
          :name="idPrefix + '-strategy'"
          type="radio"
          value="fallback"
          v-model="strategy"
        />Fallback in selection order</label
      >
      <label :for="idPrefix + '-ensemble'"
        ><input
          :id="idPrefix + '-ensemble'"
          :name="idPrefix + '-strategy'"
          type="radio"
          value="ensemble"
          v-model="strategy"
        />Parallel evaluation</label
      >
    </fieldset>
    <label
      v-if="remote.length"
      class="remote-consent"
      :for="idPrefix + '-remote-consent'"
    >
      <input
        :id="idPrefix + '-remote-consent'"
        :name="idPrefix + '-remote-consent'"
        type="checkbox"
        v-model="allowRemote"
        required
      />
      I allow prompts, source content and any requested screenshots to be sent
      through
      {{
        remote
          .map((choice) => providerNames[choice.provider] + " " + choice.model)
          .join(", ")
      }}. These providers may use remote services and incur charges.
    </label>
    <p v-if="screenshots && unsupportedVision.length" class="hint">
      A selected model reports no image support. Turn screenshots off or choose
      vision models before submitting.
    </p>
    <p v-if="error" class="picker-error" role="alert">{{ error }}</p>
  </fieldset>
</template>

<style scoped>
.model-picker {
  min-width: 0;
  margin-block: 1rem;
  border: 1px solid #7b8475;
  border-radius: 8px;
  padding: 1rem;
}
.provider-row {
  border-bottom: 1px solid #bdc8be;
  padding-block: 0.25rem;
}
.provider-row label,
.strategy-picker label,
.remote-consent {
  display: flex;
  align-items: flex-start;
  gap: 0.65rem;
  min-height: 48px;
  padding-block: 0.65rem;
  margin: 0;
  overflow-wrap: anywhere;
}
.provider-row input,
.strategy-picker input,
.remote-consent input {
  width: 20px;
  min-width: 20px;
  margin-block-start: 0.15rem;
  accent-color: #275b40;
}
.provider-row p {
  margin: 0 0 0.5rem 1.9rem;
}
.strategy-picker {
  margin-block: 1rem;
  border: 0;
  padding: 0;
}
input,
select {
  font-size: 1rem;
}
details {
  margin-block: 1rem;
}
summary {
  cursor: pointer;
  min-height: 48px;
  padding-block: 0.75rem;
}
.picker-error {
  color: #852e23;
}
button:focus-visible,
input:focus-visible,
select:focus-visible,
summary:focus-visible,
.model-picker:focus-visible {
  outline: 3px solid #275b40;
  outline-offset: 3px;
}
</style>
