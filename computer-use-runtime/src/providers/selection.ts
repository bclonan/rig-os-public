import type { ModelProvider } from "../contracts/ports.js";
import { CliModelProvider, validModelName } from "./cli.js";
import { OllamaProvider } from "./index.js";
import { TeamProvider, type ProviderStrategy } from "./team.js";

export type ProviderSelection = {
  provider: "ollama" | "codex-cli" | "claude-cli";
  model: string;
};
export { discoverCliProviders } from "./cli.js";
export {
  type ProviderStrategy,
  type ProviderCall,
  TeamProvider,
} from "./team.js";

export function validateProviderSelections(
  value: unknown,
): asserts value is ProviderSelection[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4)
    throw new Error("Choose one to four models");
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).sort().join(",") !== "model,provider" ||
      !["ollama", "codex-cli", "claude-cli"].includes(item.provider) ||
      !validModelName(item.model)
    )
      throw new Error("Provider selection rejected");
    const key = item.provider + ":" + item.model;
    if (seen.has(key))
      throw new Error("Select each provider and model only once");
    seen.add(key);
  }
}

export function createSelectedProvider(
  selections: ProviderSelection[],
  strategy: ProviderStrategy = "fallback",
  factory?: (selection: ProviderSelection) => ModelProvider,
): TeamProvider {
  validateProviderSelections(selections);
  return new TeamProvider(
    selections.map((selection) => ({
      ...selection,
      client: factory
        ? factory(selection)
        : selection.provider === "ollama"
          ? new OllamaProvider(selection.model)
          : new CliModelProvider(selection.provider, selection.model),
    })),
    strategy,
  );
}
