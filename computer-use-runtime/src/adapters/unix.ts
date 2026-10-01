import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { EnvironmentAdapter } from "../contracts/ports.js";
import type { Action, Observation, Receipt } from "../contracts/index.js";
import type { Store } from "../storage/index.js";
import { NativeClient } from "./native.js";

export function desktopPython(platform = process.platform) {
  if (process.env.CUR_DESKTOP_PYTHON) return process.env.CUR_DESKTOP_PYTHON;
  const venv = resolve(".venv-desktop/bin/python3");
  return existsSync(venv)
    ? venv
    : platform === "linux"
      ? "/usr/bin/python3"
      : "python3";
}
export class UnixAdapter implements EnvironmentAdapter {
  readonly client: NativeClient;
  readonly platform: string;
  host = "";
  session = "";
  identity = "0";
  notes = "";
  capabilities: string[] = [];
  constructor(
    private store: Store,
    platform = process.platform,
    client?: NativeClient,
  ) {
    if (!["darwin", "linux"].includes(platform))
      throw new Error("Unix desktop adapter requires macOS or Linux");
    this.platform = platform === "darwin" ? "macOS" : "Linux";
    this.client =
      client ||
      new NativeClient(desktopPython(platform), [
        "-u",
        resolve("native/unix/worker.py"),
      ]);
  }
  async start(handle = 0) {
    await this.refreshCapabilities();
    this.identity = String(handle);
    return this;
  }
  async refreshCapabilities() {
    const caps = await this.client.call("capabilities", {}, 15000);
    this.host = caps.host;
    this.session = caps.session;
    this.capabilities = caps.operations;
    this.notes = caps.notes;
    return caps;
  }
  async requestConsent() {
    try {
      return await this.client.call(
        "request_consent",
        { timeoutMs: 60000 },
        65000,
      );
    } finally {
      await this.refreshCapabilities();
    }
  }
  async cancelConsent() {
    return this.client.call("cancel_consent");
  }
  async setTarget(handle: number, pid: number) {
    await this.client.call("bind", { handle, pid });
    this.identity = String(handle);
  }
  async focus() {
    // Semantic AX/AT-SPI actions can bind controls without foreground focus.
    // The common policy and native worker reject unfocused keyboard/pointer input.
    await this.client.call("focus");
  }
  async observe(signal?: AbortSignal): Promise<Observation> {
    signal?.throwIfAborted();
    const { png, ...observation } = await this.client.call(
      "observe",
      {},
      20000,
    );
    signal?.throwIfAborted();
    return {
      ...observation,
      ...(png
        ? { image: this.store.artifact(Buffer.from(png, "base64")) }
        : {}),
    };
  }
  async acquire(runId: string) {
    return (await this.client.call("acquire", { runId })).generation;
  }
  async execute(action: Action, signal?: AbortSignal): Promise<Receipt> {
    signal?.throwIfAborted();
    const start = performance.now();
    const result = await this.client.call("execute", action);
    if (
      result?.actionId !== action.id ||
      result?.runId !== action.runId ||
      typeof result.backend !== "string" ||
      !result.backend
    )
      throw new Error("Unix receipt does not bind this action and run");
    if (result.phase === "rejected") {
      if (result.dispatched !== false || typeof result.reason !== "string")
        throw new Error("Malformed Unix rejection; delivery is uncertain");
      return {
        schemaVersion: 1,
        actionId: action.id,
        runId: action.runId,
        at: Date.now(),
        backend: result.backend,
        phase: "rejected",
        dispatched: false,
        detail: result.reason,
        timings: { dispatchMs: performance.now() - start },
      };
    }
    if (result.delivered !== true)
      throw new Error("Unix backend did not confirm action delivery");
    return {
      schemaVersion: 1,
      actionId: action.id,
      runId: action.runId,
      at: Date.now(),
      backend: result.backend,
      phase: "acknowledged",
      detail: "Native action delivered; verify the app result",
      timings: { dispatchMs: performance.now() - start },
    };
  }
  async release(runId: string) {
    await this.client.call("release", { runId });
  }
  async takeover() {
    await this.client.call("takeover");
  }
  async returnControl() {
    await this.client.call("return");
  }
  async close() {
    await this.client.close();
  }
}
