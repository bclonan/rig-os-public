import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { EnvironmentAdapter } from "../contracts/ports.js";
import type { Action, Observation, Receipt } from "../contracts/index.js";
import type { Store } from "../storage/index.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { hash } from "../storage/index.js";
import {
  OculixBackend,
  OculixDeadlineError,
  OculixCaptureError,
  capturePixels,
} from "./oculix.js";
import { bitmapToPng, bitmapChangedRegion } from "./png.js";
import { setTimeout as delay } from "node:timers/promises";
export class NativeDeadlineError extends Error {}
export class NativeClient {
  process: ChildProcessWithoutNullStreams;
  private seq = 0;
  private exited = false;
  private closed?: Promise<void>;
  private finished: Promise<void>;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    path = resolve("native/target/release/computer-use-native.exe"),
    args: string[] = [],
  ) {
    this.process = spawn(path, args, { windowsHide: true, stdio: "pipe" });
    this.process.stderr.resume();
    this.finished = new Promise((resolve) =>
      this.process.once("close", () => {
        this.exited = true;
        resolve();
      }),
    );
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => {
      let data: any;
      try {
        data = JSON.parse(line);
      } catch {
        return;
      }
      const p = this.pending.get(data.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(data.id);
        data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
      }
    });
    const fail = (e: Error) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      this.pending.clear();
    };
    this.process.on("error", fail);
    this.process.on("exit", () =>
      fail(new Error("Native backend disconnected")),
    );
  }
  call(method: string, params: any = {}, timeout = 10000): Promise<any> {
    if (this.exited || this.process.stdin.destroyed)
      return Promise.reject(new Error("Native backend is closed"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NativeDeadlineError("Native deadline; delivery uncertain"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  close() {
    return (this.closed ||= (async () => {
      if (this.exited)
        throw new Error(
          "Native worker exited before input cleanup was confirmed",
        );
      let forced = false;
      let cleanupError: unknown;
      const force = setTimeout(() => {
        forced = true;
        this.process.kill();
      }, 3000);
      try {
        try {
          const result = await this.call("stop", {}, 1500);
          if (result?.heldInputsReleased !== true)
            throw new Error("Native stop did not confirm held input release");
        } catch (error) {
          cleanupError = error;
        }
        this.process.stdin.end();
        await this.finished;
      } finally {
        clearTimeout(force);
      }
      if (cleanupError) throw cleanupError;
      if (forced)
        throw new Error("Native worker required forced shutdown after cleanup");
    })());
  }
}
export class WindowsAdapter implements EnvironmentAdapter {
  readonly platform = "Windows";
  notes = "Windows UI Automation and Win32 input";
  host = "";
  session = "";
  identity = "";
  capabilities: string[] = [];
  readonly client: NativeClient;
  private handle = 0;
  private pid = 0;
  private currentHandle = 0;
  private oculix?: OculixBackend;
  private priorCapture?: {
    target: number;
    frame: string;
    bitmap: Buffer;
    eventSequence: number;
  };
  private executableHash(path: string) {
    if (!path) return "";
    try {
      return hash(readFileSync(path));
    } catch {
      return "";
    }
  }
  constructor(
    private store: Store,
    private preferOculix = true,
    client?: NativeClient,
  ) {
    this.client = client || new NativeClient();
  }
  async start(handle: number) {
    const caps = await this.client.call("capabilities");
    this.host = caps.host;
    this.session = caps.session;
    this.capabilities = [...caps.operations, "invoke", "select", "fill"];
    const window = handle
      ? (await this.client.call("windows")).find(
          (w: any) => w.handle === handle,
        )
      : undefined;
    if (handle && !window)
      throw new Error("The selected window is unavailable");
    this.handle = handle;
    this.pid = window?.pid || 0;
    this.identity = String(handle);
    const jar = resolve(".research/Oculix/MCP/target/oculix-mcp-server.jar");
    const jdk = existsSync(".tools")
      ? readdirSync(".tools").find((x) => x.startsWith("jdk-"))
      : undefined;
    if (this.preferOculix && jdk && existsSync(jar)) {
      this.oculix = new OculixBackend();
      try {
        const capabilities = await this.oculix.start(
          resolve(".tools", jdk, "bin/java.exe"),
          jar,
        );
        this.store.put("backend", "oculix", capabilities);
      } catch (e) {
        await this.oculix.close().catch(() => {});
        this.oculix = undefined;
        this.store.put("backend", "oculix", {
          status: "unavailable",
          reason: String(e),
        });
      }
    }
    return this;
  }
  async setTarget(handle: number, pid: number) {
    const windows = await this.client.call("windows");
    if (!windows.some((w: any) => w.handle === handle && w.pid === pid))
      throw new Error(
        "The selected window closed or changed. Refresh open apps and select it again.",
      );
    this.handle = handle;
    this.pid = pid;
    this.identity = String(handle);
  }
  async focus() {
    const resolved = await this.client.call("resolve_target", {
      handle: this.handle,
    });
    const result = await this.client.call("focus", { handle: resolved.handle });
    if (!result.focused)
      throw new Error(
        "Windows did not allow focus. Bring the selected app to the front, then resume.",
      );
  }
  async observe(signal?: AbortSignal): Promise<Observation> {
    signal?.throwIfAborted();
    const settlingDeadline = Date.now() + 5000;
    const capture = (method: string, params: any = {}) => {
      signal?.throwIfAborted();
      const remaining = settlingDeadline - Date.now();
      if (remaining <= 0)
        throw new NativeDeadlineError(
          `Native read-only ${method} capture deadline`,
        );
      return this.client.call(method, params, remaining);
    };
    const optional = async (method: string, params: any, fallback: any) => {
      try {
        return await capture(method, params);
      } catch (error) {
        // An unavailable optional provider can return no facts. A deadline is
        // not missing evidence and must stop the entire coherent capture.
        if (
          error instanceof NativeDeadlineError ||
          signal?.aborted ||
          Date.now() >= settlingDeadline
        )
          throw error;
        return fallback;
      }
    };
    const windows = await capture("windows");
    if (
      !windows.some((w: any) => w.handle === this.handle && w.pid === this.pid)
    )
      throw new Error(
        "The selected window closed or changed process. Select it again.",
      );
    const changes: string[] = [];
    let previousConfirmation:
      | { handle: number; text: unknown; elements: unknown; observation: any }
      | undefined;
    const sameFrameAndFocus = (left: any, right: any) =>
      left.target === right.target &&
      left.pid === right.pid &&
      JSON.stringify(left.frame) === JSON.stringify(right.frame) &&
      left.focused === right.focused;
    const sameCapture = (left: any, right: any) =>
      left.revision === right.revision && sameFrameAndFocus(left, right);
    for (let attempt = 0; attempt < 12; attempt++) {
      if (attempt) {
        const remaining = settlingDeadline - Date.now();
        if (remaining <= 0) break;
        await delay(Math.min(80 + (attempt % 3) * 40, remaining), undefined, {
          signal,
        });
      }
      signal?.throwIfAborted();
      if (Date.now() >= settlingDeadline) break;
      if (
        attempt &&
        !(await capture("windows")).some(
          (window: any) =>
            window.handle === this.handle && window.pid === this.pid,
        )
      )
        throw new Error(
          "The selected window closed or changed process. Select it again.",
        );
      this.currentHandle = (
        await capture("resolve_target", { handle: this.handle })
      ).handle;
      if (previousConfirmation?.handle !== this.currentHandle)
        previousConfirmation = undefined;
      const text = await optional(
        "fixture_text",
        {
          handle: this.currentHandle,
        },
        {},
      );
      const elements = await optional(
        "accessibility",
        {
          handle: this.currentHandle,
        },
        [],
      );
      let o: any;
      try {
        o = await capture("observe", { handle: this.currentHandle });
      } catch (error) {
        previousConfirmation = undefined;
        if (
          error instanceof NativeDeadlineError ||
          Date.now() >= settlingDeadline
        )
          throw error;
        const current = await capture("resolve_target", {
          handle: this.handle,
        });
        if (current.handle !== this.currentHandle) continue;
        throw error;
      }
      const current = await capture("resolve_target", {
        handle: this.handle,
      });
      if (current.handle !== this.currentHandle) {
        previousConfirmation = undefined;
        continue;
      }
      // A failed pair's confirmation can start the next coherent interval.
      // Its preceding facts and these fresh facts still bracket the same two
      // full captures. This state never survives an observe invocation.
      const boundaryMatches =
        previousConfirmation &&
        JSON.stringify(previousConfirmation.text) === JSON.stringify(text) &&
        JSON.stringify(previousConfirmation.elements) ===
          JSON.stringify(elements) &&
        sameCapture(previousConfirmation.observation, o);
      if (!boundaryMatches) {
        previousConfirmation = undefined;
        const textAfter = await optional(
          "fixture_text",
          { handle: this.currentHandle },
          {},
        );
        const elementsAfter = await optional(
          "accessibility",
          { handle: this.currentHandle },
          [],
        );
        if (
          JSON.stringify(text) !== JSON.stringify(textAfter) ||
          JSON.stringify(elements) !== JSON.stringify(elementsAfter)
        ) {
          changes.push("text or accessibility controls changed");
          continue;
        }
        const confirmed = await capture("observe", {
          handle: this.currentHandle,
        });
        if (!sameCapture(o, confirmed)) {
          if (sameFrameAndFocus(o, confirmed))
            previousConfirmation = {
              handle: this.currentHandle,
              text: textAfter,
              elements: elementsAfter,
              observation: confirmed,
            };
          changes.push("pixel revision, frame or focus changed");
          continue;
        }
        // Use the worker's current native ID after either matching interval.
        o = confirmed;
      }
      let imageBytes = bitmapToPng(Buffer.from(o.image, "base64"));
      const captureProvenance: Record<string, string | number | boolean> = {
        captureBackend: "rust-win32-v1",
        captureStatus: this.preferOculix
          ? "unavailable-native-fallback"
          : "native-selected",
      };
      if (this.preferOculix)
        captureProvenance.captureFallbackReason = "capability-unavailable";
      if (
        this.preferOculix &&
        this.oculix?.capabilities().includes("observe")
      ) {
        if (
          o.target !== this.currentHandle ||
          !Number.isSafeInteger(o.pid) ||
          o.pid < 1 ||
          (this.currentHandle === this.handle && o.pid !== this.pid)
        )
          throw new Error("Preferred capture native target/PID mismatch");
        const remaining = settlingDeadline - Date.now();
        if (remaining <= 0)
          throw new NativeDeadlineError("Native read-only capture deadline");
        const captureSignal = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(remaining)])
          : AbortSignal.timeout(remaining);
        captureProvenance.captureRequestedAt = Date.now();
        let preferredImage: Buffer | undefined;
        let fallbackReason = "backend-unavailable";
        try {
          const preferred = await this.oculix.execute(
            "observe",
            {
              region: {
                x: o.frame.x,
                y: o.frame.y,
                width: o.frame.width,
                height: o.frame.height,
              },
            },
            captureSignal,
            remaining,
          );
          captureSignal.throwIfAborted();
          fallbackReason = "native-encoding-unsupported";
          const pixels = capturePixels(
            imageBytes,
            settlingDeadline,
            captureSignal,
          );
          fallbackReason = "dimension-mismatch";
          if (
            preferred.capture.width !== o.frame.width ||
            preferred.capture.height !== o.frame.height ||
            pixels.width !== o.frame.width ||
            pixels.height !== o.frame.height
          )
            throw new Error(
              "Oculix capture dimensions differ from the bound native frame",
            );
          fallbackReason = "pixel-mismatch";
          if (!pixels.rgb.equals(preferred.capture.rgb))
            throw new Error(
              "Oculix capture differs from the complete bound native frame",
            );
          preferredImage = preferred.capture.bytes;
          captureProvenance.captureBackend = preferred.backend;
          captureProvenance.captureStatus = "preferred-full-rgb-confirmed";
          delete captureProvenance.captureFallbackReason;
          captureProvenance.captureReceivedAt = Date.now();
        } catch (error) {
          captureSignal.throwIfAborted();
          if (
            error instanceof OculixDeadlineError ||
            Date.now() >= settlingDeadline
          )
            throw error;
          captureProvenance.captureStatus = "invalid-native-fallback";
          captureProvenance.captureFallbackReason =
            error instanceof OculixCaptureError
              ? "malformed-capture"
              : fallbackReason;
        }
        // Supplemental capture cannot alter the target or authorize a new pixel
        // revision. Fresh full native pixels and facts must still agree.
        const resolvedAfter = await capture("resolve_target", {
          handle: this.handle,
        });
        if (resolvedAfter.handle !== this.currentHandle) {
          previousConfirmation = undefined;
          changes.push("target changed during preferred capture");
          continue;
        }
        const textAfterPreferred = await optional(
          "fixture_text",
          { handle: this.currentHandle },
          {},
        );
        const elementsAfterPreferred = await optional(
          "accessibility",
          { handle: this.currentHandle },
          [],
        );
        const confirmedAfterPreferred = await capture("observe", {
          handle: this.currentHandle,
        });
        if (
          JSON.stringify(text) !== JSON.stringify(textAfterPreferred) ||
          JSON.stringify(elements) !== JSON.stringify(elementsAfterPreferred) ||
          !sameCapture(o, confirmedAfterPreferred)
        ) {
          previousConfirmation = undefined;
          changes.push(
            "full pixels, controls, text, frame or focus changed during preferred capture",
          );
          continue;
        }
        o = confirmedAfterPreferred;
        imageBytes =
          preferredImage || bitmapToPng(Buffer.from(o.image, "base64"));
        captureProvenance.captureConfirmedAt = o.at;
      }
      signal?.throwIfAborted();
      if (Date.now() >= settlingDeadline)
        throw new Error("Native read-only capture deadline");
      if (
        !(await capture("windows")).some(
          (window: any) =>
            window.handle === this.handle && window.pid === this.pid,
        )
      )
        throw new Error(
          "The selected window closed or changed process. Select it again.",
        );
      const windowExecutable =
        windows.find(
          (window: any) =>
            window.handle === this.handle && window.pid === this.pid,
        )?.executable || "";
      const facts: Record<string, string | number | boolean> = {
        focused: o.focused,
        windowTitle: o.title,
        windowPid: this.pid,
        windowExecutable,
        windowExecutableSha256: this.executableHash(windowExecutable),
        desktopPlatform: "Windows",
        ownedDialog: this.currentHandle !== this.handle,
        windowHandle: this.currentHandle,
        ...captureProvenance,
        captureImageSha256: hash(imageBytes),
        ...(text.text === undefined ? {} : { text: text.text }),
      };
      const bitmap = Buffer.from(o.image, "base64");
      const prior = this.priorCapture;
      const sameTarget =
        prior?.target === this.currentHandle &&
        prior.frame === JSON.stringify(o.frame);
      if (sameTarget) {
        try {
          const region = bitmapChangedRegion(prior!.bitmap, bitmap);
          facts.changedRegion = JSON.stringify(
            region
              ? { ...region, x: region.x + o.frame.x, y: region.y + o.frame.y }
              : null,
          );
        } catch {
          facts.changedRegion = JSON.stringify(o.frame);
        }
      } else facts.changedRegion = JSON.stringify(o.frame);
      const events = o.nativeEvents;
      if (
        events?.available === true &&
        events.target === this.currentHandle &&
        Number.isSafeInteger(events.sequence) &&
        Array.isArray(events.events)
      ) {
        const relevant = events.events.filter(
          (event: any) =>
            Number.isSafeInteger(event.sequence) &&
            event.sequence > (sameTarget ? prior!.eventSequence : 0),
        );
        const kinds = new Set(
          relevant.map((event: any) =>
            event.event === 3 || event.event === 0x8005
              ? "focus"
              : event.event === 0x800b
                ? "bounds"
                : event.event === 0x800e || event.event === 0x800c
                  ? "value"
                  : "controls",
          ),
        );
        facts.nativeEventsAvailable = true;
        facts.nativeEventSequence = events.sequence;
        facts.nativeEventCount = relevant.length;
        facts.nativeEventDependencies = JSON.stringify([...kinds]);
        facts.nativeEventGap = Boolean(
          sameTarget &&
          relevant.length &&
          relevant[0].sequence > prior!.eventSequence + 1,
        );
      } else facts.nativeEventsAvailable = false;
      this.priorCapture = {
        target: this.currentHandle,
        frame: JSON.stringify(o.frame),
        bitmap,
        eventSequence: Number(events?.sequence || 0),
      };
      const ambiguous = new Set<string>();
      for (const el of elements) {
        if (!el.id || el.offscreen) continue;
        const key = "uia." + el.id;
        if (key in facts) ambiguous.add(key);
        facts[key] = el.value || el.name;
      }
      for (const key of ambiguous) delete facts[key];
      const canvases = elements.filter(
        (element: any) => element.id === "image" && !element.offscreen,
      );
      if (canvases.length === 1) {
        const bounds = canvases[0].bounds;
        try {
          const region = {
            x: Math.ceil(bounds.x - o.frame.x),
            y: Math.ceil(bounds.y - o.frame.y),
            width:
              Math.floor(bounds.x + bounds.width - o.frame.x) -
              Math.ceil(bounds.x - o.frame.x),
            height:
              Math.floor(bounds.y + bounds.height - o.frame.y) -
              Math.ceil(bounds.y - o.frame.y),
          };
          facts.canvasImage = this.store.artifact(
            bitmapToPng(Buffer.from(o.image, "base64"), region),
          );
          facts.canvasBounds = JSON.stringify(bounds);
        } catch {
          // An unverified crop cannot support semantic completion.
        }
      }
      this.store.put("backend", "last-capture", {
        observationId: o.id,
        nativeRevision: o.revision,
        host: o.host,
        session: o.session,
        target: this.identity,
        resolvedTarget: this.currentHandle,
        pid: this.pid,
        frame: o.frame,
        ...captureProvenance,
        imageSha256: hash(imageBytes),
      });
      return {
        schemaVersion: 1,
        id: o.id,
        host: o.host,
        session: o.session,
        target: this.identity,
        at: o.at,
        revision: o.revision,
        frame: o.frame,
        focused: o.focused,
        facts,
        image: this.store.artifact(imageBytes),
        controls: elements,
        features: [],
        backend: "rust-win32-v1",
      };
    }
    throw new Error(
      "The target kept changing during capture. Observe again before any input. " +
        changes.join("; "),
    );
  }
  async acquire(runId: string) {
    return (await this.client.call("acquire", { runId })).generation;
  }
  async execute(action: Action, signal?: AbortSignal): Promise<Receipt> {
    signal?.throwIfAborted();
    let backend = "rust-win32-v1";
    const start = performance.now();
    if (action.operation === "click" && action.args.locator) {
      const elements = await this.client.call("accessibility", {
        handle: this.currentHandle,
      });
      const matches = elements.filter((e: any) => {
        const named = /^@name:(\d+):([\s\S]*)$/.exec(
          String(action.args.locator),
        );
        return (
          !e.offscreen &&
          (named
            ? e.controlType === Number(named[1]) && e.name === named[2]
            : e.id === action.args.locator)
        );
      });
      if (matches.length !== 1)
        throw new Error("UIA pointer locator missing or ambiguous");
      const rect = matches[0].bounds;
      action = {
        ...action,
        args: {
          ...action.args,
          x: Math.round(rect.x + rect.width / 2 - action.frame.x),
          y: Math.round(rect.y + rect.height / 2 - action.frame.y),
        },
      };
    }
    if (
      this.oculix &&
      this.oculix.capabilities().includes(action.operation) &&
      ["click", "type", "key", "scroll"].includes(action.operation)
    ) {
      await this.client.call("authorize", {
        ...action,
        target: this.currentHandle,
      });
      let args: Record<string, unknown>;
      if (action.operation === "click")
        args = {
          x: action.frame.x + Number(action.args.x),
          y: action.frame.y + Number(action.args.y),
        };
      else if (action.operation === "type") args = { text: action.args.text };
      else if (action.operation === "scroll")
        args = {
          direction: Number(action.args.amount) < 0 ? "down" : "up",
          steps: Math.max(1, Math.abs(Number(action.args.amount || 120)) / 120),
          region: {
            x: action.frame.x,
            y: action.frame.y,
            width: action.frame.width,
            height: action.frame.height,
          },
        };
      else {
        const tokens = String(action.args.key).split("+"),
          key = tokens.pop()!.toLowerCase();
        args = {
          key,
          modifiers: tokens.map((x) =>
            x === "Control" ? "ctrl" : x.toLowerCase(),
          ),
        };
        if (
          (args.modifiers as string[]).some(
            (x) => !["ctrl", "shift", "alt"].includes(x),
          )
        )
          throw new Error("Unsupported key modifier");
      }
      try {
        const receipt = await this.oculix.execute(
          action.operation as "click" | "type" | "key" | "scroll",
          args,
          signal,
        );
        backend = receipt.backend;
      } catch (e) {
        await this.oculix.close();
        await this.client.call("stop");
        throw e;
      }
    } else {
      const r = await this.client.call("execute", {
        ...action,
        target: this.currentHandle,
      });
      if (r.phase === "rejected") {
        if (
          r.actionId !== action.id ||
          r.runId !== action.runId ||
          r.dispatched !== false ||
          typeof r.reason !== "string"
        )
          throw new Error("Native rejection identity or phase is invalid");
        return {
          schemaVersion: 1,
          actionId: action.id,
          runId: action.runId,
          backend: r.backend,
          phase: "rejected",
          dispatched: false,
          at: Date.now(),
          detail: r.reason,
          timings: { dispatchMs: performance.now() - start },
        };
      }
      if (r.acknowledged !== true)
        throw new Error("Native dispatch did not acknowledge delivery");
      backend = action.operation === "invoke" ? "rust-uia-v1" : r.backend;
    }
    return {
      schemaVersion: 1,
      actionId: action.id,
      runId: action.runId,
      backend,
      phase: "acknowledged",
      at: Date.now(),
      detail: "Native input dispatched, independent verification required",
      timings: { dispatchMs: performance.now() - start },
    };
  }
  async release(runId: string) {
    await this.client.call("release", { runId });
  }
  async takeover() {
    await this.cleanupOwned("takeover", () => this.client.call("takeover"));
  }
  async returnControl() {
    await this.client.call("return");
  }
  async close() {
    await this.cleanupOwned("close", () => this.client.close());
  }
  private async cleanupOwned(
    operation: string,
    guarded: () => Promise<unknown>,
  ) {
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => this.oculix?.close()),
      Promise.resolve().then(guarded),
    ]);
    if (outcomes[0].status === "fulfilled") this.oculix = undefined;
    const errors = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, `Native ${operation} cleanup failed`);
  }
}
