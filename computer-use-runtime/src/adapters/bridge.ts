import type { EnvironmentAdapter } from "../contracts/ports.js";
import {
  validate,
  type Observation,
  type Action,
  type Receipt,
} from "../contracts/index.js";
/** Inject actual host RPC handlers. No existing host endpoints are assumed. */
export class BridgeAdapter implements EnvironmentAdapter {
  constructor(
    readonly host: string,
    readonly session: string,
    readonly identity: string,
    readonly capabilities: string[],
    private rpc: (method: string, args: unknown) => Promise<any>,
  ) {}
  async observe() {
    const o = validate<Observation>(
      "Observation",
      await this.rpc("capture", {}),
    );
    if (
      o.host !== this.host ||
      o.session !== this.session ||
      o.target !== this.identity
    )
      throw new Error("Bridge switched target");
    return o;
  }
  async acquire(runId: string) {
    const generation = (
      await this.rpc("acquire", {
        runId,
        host: this.host,
        session: this.session,
      })
    ).generation;
    if (!Number.isSafeInteger(generation) || generation < 1)
      throw new Error("Bridge lease generation is invalid");
    return generation;
  }
  async execute(a: Action) {
    validate("Action", a);
    if (
      a.host !== this.host ||
      a.session !== this.session ||
      a.target !== this.identity
    )
      throw new Error("Wrong bridge host");
    const receipt = validate<Receipt>("Receipt", await this.rpc("actuate", a));
    if (receipt.actionId !== a.id || receipt.runId !== a.runId)
      throw new Error("Bridge receipt belongs to another action or run");
    return receipt;
  }
  async release(runId: string) {
    await this.rpc("release", { runId });
  }
  async takeover() {
    await this.rpc("takeover", {});
  }
  async returnControl() {
    await this.rpc("return", {});
  }
  async close() {
    await this.rpc("close", {});
  }
}
