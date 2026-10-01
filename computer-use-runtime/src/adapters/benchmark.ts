import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { inflateSync } from "node:zlib";
import type { EnvironmentAdapter } from "../contracts/ports.js";
import {
  validate,
  type Action,
  type Observation,
  type Receipt,
} from "../contracts/index.js";
import { Lease } from "../runtime/policy.js";
import { canonical, hash, type Store } from "../storage/index.js";
import { keys } from "../assistant/planner.js";

export interface BenchmarkSnapshot {
  screenshot: string;
  accessibility_tree?: string;
}
export interface BenchmarkGrant {
  host: string;
  session: string;
  identity: string;
  platform: "Windows" | "Linux";
  track: "pixel" | "structured";
  /** Handwritten embedding code only. Receives public observation bytes, never reward/evaluator/config. */
  measure?: (snapshot: Readonly<BenchmarkSnapshot>) => {
    facts?: Observation["facts"];
    controls?: Observation["controls"];
  };
}
export interface BenchmarkDispatch {
  id: string;
  runId: string;
  host: string;
  session: string;
  operation: string;
  args: Action["args"];
  deadline: number;
}
type Pending = {
  action: Action;
  emitted: boolean;
  startedAt: number;
  settle: (receipt: Receipt) => void;
  reject: (error: Error) => void;
};
const MAX_IMAGE = 6 * 1024 * 1024;
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}
/** Bounded PNG envelope validation. The benchmark runner supplies the actual pixels. */
function pngFrame(encoded: string) {
  if (
    typeof encoded !== "string" ||
    encoded.length > Math.ceil(MAX_IMAGE / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  )
    throw new Error(
      "Benchmark screenshot must be bounded canonical base64 PNG",
    );
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length < 57 ||
    bytes.length > MAX_IMAGE ||
    bytes.toString("base64") !== encoded ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("Invalid benchmark PNG signature");
  let offset = 8,
    width = 0,
    height = 0,
    data = false,
    ended = false,
    channels = 0;
  const compressed: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset),
      end = offset + 12 + length;
    if (end > bytes.length) throw new Error("Truncated benchmark PNG chunk");
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (
      crc(bytes.subarray(offset + 4, offset + 8 + length)) !==
      bytes.readUInt32BE(offset + 8 + length)
    )
      throw new Error("Benchmark PNG checksum mismatch");
    if (offset === 8) {
      if (kind !== "IHDR" || length !== 13)
        throw new Error("Missing benchmark PNG dimensions");
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[
        bytes[offset + 17]
      ];
      if (
        bytes[offset + 16] !== 8 ||
        !channels ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        bytes[offset + 20] !== 0
      )
        throw new Error(
          "Benchmark PNG requires noninterlaced 8-bit grayscale/RGB pixels",
        );
      if (
        !width ||
        !height ||
        width > 4096 ||
        height > 4096 ||
        width * height > 16000000
      )
        throw new Error("Benchmark PNG dimensions exceed authorized limits");
    } else if (kind === "IHDR")
      throw new Error("Duplicate benchmark PNG header");
    if (kind === "IDAT") {
      data = true;
      compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    if (kind === "IEND") {
      if (length !== 0 || end !== bytes.length || !data)
        throw new Error("Invalid benchmark PNG ending");
      ended = true;
      break;
    }
    offset = end;
  }
  if (!ended) throw new Error("Missing benchmark PNG ending");
  const rowBytes = width * channels + 1;
  const pixels = inflateSync(Buffer.concat(compressed), {
    maxOutputLength: rowBytes * height,
  });
  if (pixels.length !== rowBytes * height)
    throw new Error("Benchmark PNG pixel dimensions mismatch");
  for (let row = 0; row < height; row++)
    if (pixels[row * rowBytes] > 4)
      throw new Error("Invalid benchmark PNG row filter");
  return { bytes, frame: { x: 0, y: 0, width, height, scale: 1 } };
}

/** Single Runtime lane. A receipt attests a runner roundtrip, not measured application success. */
export class BenchmarkEnvironmentAdapter implements EnvironmentAdapter {
  readonly host: string;
  readonly session: string;
  readonly identity: string;
  readonly capabilities = [
    "click",
    "type",
    "key",
    "scroll",
    "drag",
    "wait",
    "observe",
  ];
  readonly grant: Readonly<BenchmarkGrant>;
  private readonly lease = new Lease();
  private snapshot?: Observation;
  private sequence = 0;
  private pending?: Pending;
  private closed = false;
  private uncertain = false;
  constructor(
    private readonly store: Store,
    grant: BenchmarkGrant,
  ) {
    if (
      ![grant.host, grant.session, grant.identity].every(
        (value) =>
          typeof value === "string" && value.length > 0 && value.length <= 256,
      ) ||
      !["Windows", "Linux"].includes(grant.platform) ||
      !["pixel", "structured"].includes(grant.track)
    )
      throw new Error("Invalid trusted benchmark grant");
    this.grant = Object.freeze({ ...grant });
    this.host = grant.host;
    this.session = grant.session;
    this.identity = grant.identity;
  }
  receive(value: unknown, pendingId: unknown, host: string, session: string) {
    if (
      this.closed ||
      this.uncertain ||
      host !== this.host ||
      session !== this.session
    )
      throw new Error("Wrong or closed benchmark session");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid benchmark observation");
    const raw = value as Record<string, unknown>;
    if (
      Object.keys(raw).some(
        (key) => !["screenshot", "accessibility_tree"].includes(key),
      )
    )
      throw new Error("Private benchmark evaluator inputs are forbidden");
    if (this.grant.track === "pixel" && raw.accessibility_tree !== undefined)
      throw new Error("Pixel track forbids accessibility observations");
    if (
      raw.accessibility_tree !== undefined &&
      (typeof raw.accessibility_tree !== "string" ||
        Buffer.byteLength(raw.accessibility_tree) > 262144)
    )
      throw new Error("Accessibility observation must be bounded public text");
    if (
      this.pending
        ? pendingId !== this.pending.action.id || !this.pending.emitted
        : pendingId !== null && pendingId !== undefined
    )
      throw new Error(
        "Benchmark acknowledgment does not bind the outstanding action",
      );
    const image = pngFrame(raw.screenshot as string);
    const snapshot = Object.freeze({
      screenshot: raw.screenshot as string,
      ...(raw.accessibility_tree !== undefined
        ? { accessibility_tree: raw.accessibility_tree as string }
        : {}),
    });
    const measured = this.grant.measure?.(snapshot) || {};
    const at = Date.now();
    const facts = {
      ...measured.facts,
      focused: true,
      desktopPlatform: this.grant.platform,
      supportedOperations: JSON.stringify(this.capabilities),
      supportedKeys: JSON.stringify(
        keys.filter((key) => !key.startsWith("Meta+")),
      ),
      benchmarkObservationSequence: this.sequence + 1,
      benchmarkReceivedAt: at,
      ...(snapshot.accessibility_tree !== undefined
        ? { visibleControls: snapshot.accessibility_tree.slice(0, 8192) }
        : {}),
    };
    const observation = validate<Observation>("Observation", {
      schemaVersion: 1,
      id: randomUUID(),
      host: this.host,
      session: this.session,
      target: this.identity,
      at,
      revision: hash(
        canonical({
          image: hash(image.bytes),
          tree: snapshot.accessibility_tree,
          facts,
          controls: measured.controls,
        }),
      ),
      frame: image.frame,
      focused: true,
      facts,
      image: this.store.artifact(image.bytes),
      features: [],
      ...(measured.controls ? { controls: measured.controls } : {}),
      backend: "benchmark-computer_13-runner",
    });
    this.sequence++;
    this.snapshot = observation;
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      if (pending.action.deadline < at) {
        this.uncertain = true;
        this.lease.takeover();
        pending.reject(
          new Error(
            "Benchmark runner acknowledgment arrived after action deadline; delivery remains uncertain",
          ),
        );
      } else
        pending.settle({
          schemaVersion: 1,
          actionId: pending.action.id,
          runId: pending.action.runId,
          backend: observation.backend,
          at,
          phase: "acknowledged",
          detail:
            "Benchmark runner supplied the following observation for this exact action. Application effect requires independent verification.",
          timings: {
            runnerRoundtrip: at - pending.startedAt,
          },
        });
    }
  }
  async observe(signal?: AbortSignal) {
    const until = Date.now() + 10000;
    while (!this.snapshot || Date.now() - this.snapshot.at > 1500) {
      if (this.closed) throw new Error("Benchmark adapter closed");
      signal?.throwIfAborted();
      if (Date.now() >= until)
        throw new Error("Fresh benchmark runner observation unavailable");
      await delay(10, undefined, { signal });
    }
    return this.snapshot;
  }
  async acquire(runId: string) {
    if (this.uncertain)
      throw new Error(
        "Reset the benchmark environment before reacquiring uncertain input",
      );
    return this.lease.acquire(runId);
  }
  async execute(action: Action, signal?: AbortSignal): Promise<Receipt> {
    validate("Action", action);
    const reject = (detail: string): Receipt => ({
      schemaVersion: 1,
      actionId: action.id,
      runId: action.runId,
      backend: "benchmark-computer_13-runner",
      at: Date.now(),
      phase: "rejected",
      dispatched: false,
      detail,
      timings: {},
    });
    try {
      this.lease.check(action);
      signal?.throwIfAborted();
    } catch {
      return reject(
        "Benchmark lease or cancellation rejected input before dispatch",
      );
    }
    if (
      this.closed ||
      this.pending ||
      !this.snapshot ||
      action.host !== this.host ||
      action.session !== this.session ||
      action.target !== this.identity ||
      action.observationId !== this.snapshot.id ||
      action.revision !== this.snapshot.revision ||
      Date.now() - this.snapshot.at > 2000 ||
      canonical(action.frame) !== canonical(this.snapshot.frame) ||
      action.deadline <= Date.now()
    )
      return reject(
        "Benchmark target, frame, lease observation or action deadline changed before dispatch",
      );
    if (
      !this.capabilities.includes(action.operation) ||
      action.operation === "observe"
    )
      return reject("Unsupported benchmark operation");
    const point = (x: unknown, y: unknown) =>
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      Number(x) >= 0 &&
      Number(y) >= 0 &&
      Number(x) < action.frame.width &&
      Number(y) < action.frame.height;
    if (
      (action.operation === "click" || action.operation === "drag") &&
      (!point(action.args.x, action.args.y) ||
        (action.operation === "drag" && !point(action.args.dx, action.args.dy)))
    )
      return reject("Benchmark point is outside the full screenshot frame");
    if (
      action.operation === "type" &&
      (typeof action.args.text !== "string" ||
        Buffer.byteLength(action.args.text) > 8192 ||
        /[\x00-\x08\x0b-\x1f]/.test(action.args.text))
    )
      return reject("Benchmark typing requires bounded literal text");
    if (
      action.operation === "key" &&
      (typeof action.args.key !== "string" ||
        !keys.includes(action.args.key) ||
        action.args.key.startsWith("Meta+"))
    )
      return reject("Unsupported benchmark key chord");
    if (
      action.operation === "scroll" &&
      (!Number.isInteger(action.args.amount) ||
        !action.args.amount ||
        Math.abs(Number(action.args.amount)) > 1200)
    )
      return reject(
        "Benchmark scroll requires signed wheel amount within 1200",
      );
    return new Promise<Receipt>((settle, fail) => {
      const timer = setTimeout(
        () =>
          failPending(
            "Benchmark action deadline expired before the runner returned; delivery remains uncertain",
          ),
        Math.min(120000, action.deadline - Date.now()),
      );
      const aborted = () =>
        failPending(
          "Benchmark execution interrupted; dispatched delivery remains uncertain",
        );
      const clean = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
      };
      const failPending = (message: string) => {
        const emitted = this.pending?.emitted;
        this.pending = undefined;
        clean();
        if (emitted) {
          this.uncertain = true;
          this.lease.takeover();
          fail(new Error(message));
        } else
          settle(
            reject(
              "Benchmark action was withdrawn before being returned to the runner",
            ),
          );
      };
      this.pending = {
        action: structuredClone(action),
        emitted: false,
        startedAt: Date.now(),
        settle: (receipt) => {
          clean();
          settle(receipt);
        },
        reject: (error) => {
          clean();
          fail(error);
        },
      };
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }
  /** Only this adapter's already-authorized operation can be returned to the runner. Never replay emitted operations. */
  poll(): BenchmarkDispatch | undefined {
    if (!this.pending || this.pending.emitted) return undefined;
    if (this.pending.action.deadline <= Date.now()) return undefined;
    this.pending.emitted = true;
    const action = this.pending.action;
    return {
      id: action.id,
      runId: action.runId,
      host: action.host,
      session: action.session,
      operation: action.operation,
      args: structuredClone(action.args),
      deadline: action.deadline,
    };
  }
  async release(runId: string) {
    if (this.pending?.action.runId === runId) {
      const pending = this.pending;
      this.pending = undefined;
      if (pending.emitted) {
        this.uncertain = true;
        this.lease.takeover();
      }
      pending.reject(
        new Error(
          "Input owner released with an outstanding benchmark action; no automatic replay",
        ),
      );
    }
    this.lease.release(runId);
  }
  async reset() {
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      pending.reject(
        new Error("Benchmark reset invalidated outstanding input"),
      );
    }
    this.snapshot = undefined;
    this.sequence = 0;
    this.uncertain = false;
    this.lease.takeover();
    this.lease.returnControl();
  }
  async takeover() {
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      if (pending.emitted) this.uncertain = true;
      pending.reject(
        new Error(
          "Manual takeover interrupted benchmark input; do not replay outstanding actions",
        ),
      );
    }
    this.snapshot = undefined;
    this.lease.takeover();
  }
  async returnControl() {
    if (this.uncertain)
      throw new Error(
        "Reset the benchmark environment before returning control after uncertain input",
      );
    this.lease.returnControl();
  }
  async close() {
    await this.reset();
    this.closed = true;
  }
}
