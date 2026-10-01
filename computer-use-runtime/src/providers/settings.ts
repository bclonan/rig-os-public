import type { ProviderSelection, ProviderStrategy } from "./selection.js";
import { validModelName } from "./cli.js";

export type ProviderSettings = {
  providers: ProviderSelection[];
  strategy: ProviderStrategy;
  allowRemote: boolean;
  model: string;
};

/** Resolve legacy Ollama requests and freeze explicit external-provider consent. */
export function providerSettings(value: unknown): ProviderSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Choose at least one model provider");
  const body = value as Record<string, unknown>;
  const entries = body.providers ?? [{ provider: "ollama", model: body.model }];
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 4)
    throw new Error("Choose one to four model providers");
  const providers = entries.map((entry): ProviderSelection => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Invalid model provider selection");
    const item = entry as Record<string, unknown>;
    if (
      Object.keys(item).some((key) => !["provider", "model"].includes(key)) ||
      !["ollama", "codex-cli", "claude-cli"].includes(String(item.provider)) ||
      !validModelName(item.model)
    )
      throw new Error(
        "Choose a supported provider and a model name of at most 200 characters",
      );
    return {
      provider: item.provider as ProviderSelection["provider"],
      model: item.model,
    };
  });
  if (
    new Set(providers.map((item) => item.provider + ":" + item.model)).size !==
    providers.length
  )
    throw new Error("Each selected provider and model must be different");
  const strategy = body.strategy ?? "fallback";
  if (strategy !== "fallback" && strategy !== "ensemble")
    throw new Error("Choose ordered fallback or parallel ensemble");
  if (body.allowRemote !== undefined && typeof body.allowRemote !== "boolean")
    throw new Error("Invalid external-provider consent");
  const allowRemote = body.allowRemote === true;
  if (providers.some((item) => item.provider !== "ollama") && !allowRemote)
    throw new Error(
      "Allow the selected external CLI providers to receive task text and any enabled screenshots before starting",
    );
  return { providers, strategy, allowRemote, model: providers[0].model };
}

export function providerParameters(settings: ProviderSettings) {
  return {
    plannerModel: settings.model,
    plannerProviders: JSON.stringify(settings.providers),
    providerStrategy: settings.strategy,
    allowRemote: settings.allowRemote,
  };
}

export function taskProviderSettings(parameters: Record<string, unknown>) {
  let providers: unknown;
  if (parameters.plannerProviders !== undefined) {
    if (
      typeof parameters.plannerProviders !== "string" ||
      parameters.plannerProviders.length > 4096
    )
      throw new Error("Invalid saved provider selection");
    try {
      providers = JSON.parse(parameters.plannerProviders);
    } catch {
      throw new Error("Invalid saved provider selection");
    }
  }
  return providerSettings({
    model: parameters.plannerModel,
    providers,
    strategy: parameters.providerStrategy,
    allowRemote: parameters.allowRemote,
  });
}
