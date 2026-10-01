import { seal, seedForm } from "../src/skills/index.js";
export const customSkill = seal({
  ...seedForm(),
  id: "example.custom-form",
  description: "Example extension registered through the public skill contract",
});
export { LocalEndpointProvider as CustomProvider } from "../src/providers/index.js";
export { BridgeAdapter as CustomEnvironment } from "../src/adapters/bridge.js";
