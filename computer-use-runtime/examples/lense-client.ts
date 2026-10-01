import { RuntimeClient } from "../src/sdk/index.js";
import type { TaskContract } from "../src/contracts/index.js";
/** Proposed mapping. Actual Lense protocol compatibility remains UNVERIFIED. */
export class LenseRuntimeClient {
  constructor(readonly runtime: RuntimeClient) {}
  submitGoal(contract: TaskContract) {
    return this.runtime.submit(contract);
  }
  evidence(runId: string) {
    return this.runtime.request(
      `/api/tasks/${encodeURIComponent(runId)}/evidence`,
    );
  }
  pause(runId: string) {
    return this.runtime.control(runId, "pause");
  }
}
export { BridgeAdapter } from "../src/adapters/bridge.js";
