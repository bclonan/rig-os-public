import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { NativeClient, WindowsAdapter } from "../src/adapters/native.js";
import {
  capturePixels,
  OculixBackend,
  OculixDeadlineError,
  oculixCapture,
} from "../src/adapters/oculix.js";
import { bitmapToPng } from "../src/adapters/png.js";
import { Store, hash } from "../src/storage/index.js";
import { Lease } from "../src/runtime/policy.js";

function chunk(name: string, bytes: Buffer) {
  const content = Buffer.concat([Buffer.from(name), bytes]);
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, content, checksum]);
}

function png(rgb: Buffer, width = 3, height = 2, filter = 0, alpha?: number) {
  const channels = alpha === undefined ? 3 : 4;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 3 ? 2 : 6;
  const stride = width * channels,
    pixels = Buffer.alloc(stride * height),
    raw = Buffer.alloc((stride + 1) * height);
  for (let pixel = 0; pixel < width * height; pixel++) {
    rgb.copy(pixels, pixel * channels, pixel * 3, pixel * 3 + 3);
    if (channels === 4) pixels[pixel * channels + 3] = alpha!;
  }
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x,
        left = x >= channels ? pixels[at - channels] : 0,
        above = y ? pixels[at - stride] : 0,
        diagonal = y && x >= channels ? pixels[at - stride - channels] : 0;
      const p = left + above - diagonal,
        a = Math.abs(p - left),
        b = Math.abs(p - above),
        c = Math.abs(p - diagonal);
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : a <= b && a <= c
                  ? left
                  : b <= c
                    ? above
                    : diagonal;
      raw[y * (stride + 1) + x + 1] = (pixels[at] - predictor) & 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function bitmap(rgb: Buffer) {
  const bytes = Buffer.alloc(54 + 3 * 2 * 4);
  bytes.write("BM");
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(3, 18);
  bytes.writeInt32LE(-2, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(32, 28);
  for (let pixel = 0; pixel < 6; pixel++) {
    const at = 54 + pixel * 4;
    bytes[at] = rgb[pixel * 3 + 2];
    bytes[at + 1] = rgb[pixel * 3 + 1];
    bytes[at + 2] = rgb[pixel * 3];
  }
  return bytes;
}

const rgb = Buffer.from([
  4, 21, 37, 83, 101, 119, 197, 211, 239, 31, 59, 71, 127, 139, 151, 223, 241,
  251,
]);
const result = (bytes: Buffer) => ({
  content: [
    {
      type: "image" as const,
      mimeType: "image/png",
      data: bytes.toString("base64"),
    },
  ],
});

test("preferred capture compares every RGB byte across supported PNG filters and rejects corrupt, transparent or oversized images", () => {
  for (let filter = 0; filter < 5; filter++)
    for (const alpha of [undefined, 255]) {
      const pixels = capturePixels(png(rgb, 3, 2, filter, alpha));
      assert.equal(pixels.width, 3);
      assert.equal(pixels.height, 2);
      assert.deepEqual(pixels.rgb, rgb);
    }
  const corrupt = png(rgb);
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => capturePixels(corrupt), /checksum/);
  assert.throws(() => capturePixels(png(rgb, 3, 2, 0, 254)), /Transparent/);
  assert.throws(
    () => capturePixels(Buffer.alloc(16 * 1024 * 1024 + 1)),
    /oversized/,
  );
  assert.throws(() => capturePixels(png(rgb).subarray(0, 40)), /Truncated/);
  const valid = png(rgb);
  for (const name of ["ABCD", "iCCP"])
    assert.throws(
      () =>
        capturePixels(
          Buffer.concat([
            valid.subarray(0, 33),
            chunk(name, Buffer.alloc(0)),
            valid.subarray(33),
          ]),
        ),
      /Unsupported capture PNG chunk/,
    );
  const unsupportedHeader = Buffer.from(valid.subarray(16, 29));
  unsupportedHeader[10] = 1;
  assert.throws(
    () =>
      capturePixels(
        Buffer.concat([
          valid.subarray(0, 8),
          chunk("IHDR", unsupportedHeader),
          valid.subarray(33),
        ]),
      ),
    /Unsupported capture PNG encoding/,
  );
  const oversizedHeader = Buffer.from(valid.subarray(16, 29));
  oversizedHeader.writeUInt32BE(8193, 0);
  assert.throws(
    () =>
      capturePixels(
        Buffer.concat([
          valid.subarray(0, 8),
          chunk("IHDR", oversizedHeader),
          valid.subarray(33),
        ]),
      ),
    /Unsupported capture PNG encoding/,
  );
  assert.throws(
    () =>
      capturePixels(
        Buffer.concat([
          valid.subarray(0, 33),
          chunk("IDAT", deflateSync(Buffer.alloc(100))),
          chunk("IEND", Buffer.alloc(0)),
        ]),
      ),
    /larger than|output length/i,
  );
  assert.throws(
    () => capturePixels(png(rgb, 3, 2, 5)),
    /Unsupported capture PNG filter/,
  );
  assert.throws(
    () =>
      oculixCapture({
        content: [result(png(rgb)).content[0], result(png(rgb)).content[0]],
      }),
    /one bounded PNG/,
  );
  assert.throws(
    () => oculixCapture({ isError: true, ...result(png(rgb)) }),
    /invalid capture result/,
  );
  assert.throws(
    () =>
      oculixCapture({
        content: [
          { type: "image", mimeType: "image/png", data: "not-base64!" },
        ],
      }),
    /one bounded PNG/,
  );
});

async function fixture(mode: string, decodingDeadline?: () => void) {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "cur-preferred-capture-")),
  );
  const abort = new AbortController(),
    backend = new OculixBackend();
  const lease = new Lease();
  (backend as unknown as { tools: Map<string, unknown> }).tools = new Map(
    mode === "absent"
      ? []
      : [
          [
            "oculix_screenshot",
            {
              inputSchema: {
                type: "object",
                required: ["region"],
                properties: {
                  region: {
                    type: "object",
                    required: ["x", "y", "width", "height"],
                    properties: {
                      x: { type: "integer" },
                      y: { type: "integer" },
                      width: { type: "integer" },
                      height: { type: "integer" },
                    },
                  },
                },
              },
            },
          ],
        ],
  );
  let captures = 0,
    preferredCalls = 0,
    pid = 9,
    active = 1,
    text = "same",
    focus = true,
    frameX = 100,
    value = "same",
    currentRgb = Buffer.from(rgb);
  let preferredBytes = png(rgb);
  const calls: string[] = [];
  backend.client.callTool = async (
    request: any,
    _schema: any,
    options: any,
  ) => {
    preferredCalls++;
    assert.equal(request.name, "oculix_screenshot");
    assert.deepEqual(request.arguments.region, {
      x: frameX,
      y: 200,
      width: 3,
      height: 2,
    });
    assert.ok(options.timeout > 0 && options.timeout <= 5000);
    assert.ok(options.signal);
    if (mode === "deadline")
      throw { code: -32001, message: "Request timed out" };
    if (mode === "cancel") abort.abort();
    if (mode === "unavailable")
      throw new Error(
        "Backend unavailable with private arbitrary error detail",
      );
    let pixels = Buffer.from(currentRgb);
    if (mode === "mismatch") pixels[0] ^= 1;
    preferredBytes = png(pixels, 3, 2, 4);
    if (mode === "pixel-change") currentRgb[0] ^= 1;
    if (mode === "text-change") text += "!";
    if (mode === "controls-change") value += "!";
    if (mode === "focus-change") focus = !focus;
    if (mode === "frame-change") frameX++;
    if (mode === "pid-change") pid++;
    if (mode === "target-change" && preferredCalls === 1) active = 2;
    if (mode === "dimensions") return result(png(pixels.subarray(0, 6), 1, 2));
    if (mode === "malformed") return { content: [] };
    if (mode === "decode-deadline") {
      const value = result(preferredBytes);
      let firstRead = true;
      Object.defineProperty(value.content[0], "data", {
        get() {
          if (firstRead) {
            firstRead = false;
            decodingDeadline!();
          }
          return preferredBytes.toString("base64");
        },
      });
      return value;
    }
    return result(preferredBytes);
  };
  const client = {
    async call(method: string, params: any = {}, timeout = 10000) {
      calls.push(method);
      if (method === "capabilities")
        return {
          host: "test-host",
          session: "test-session",
          operations: ["observe", "click"],
        };
      if (method === "acquire")
        return { generation: lease.acquire(params.runId) };
      if (method === "release") return lease.release(params.runId);
      if (method === "execute") {
        lease.check(params);
        assert.equal(params.target, active);
        return {
          acknowledged: true,
          backend: "rust-win32-v1",
          actionId: params.id,
          runId: params.runId,
        };
      }
      if (method === "windows") return [{ handle: 1, pid }];
      if (method === "resolve_target") return { handle: active };
      if (method === "fixture_text") return { text };
      if (method === "accessibility")
        return [
          {
            index: 0,
            id: "label",
            value,
            name: "same",
            offscreen: false,
            focused: false,
            controlType: 50020,
            bounds: { x: frameX, y: 200, width: 3, height: 2 },
          },
        ];
      if (method === "observe") {
        assert.ok(timeout <= 5000);
        captures++;
        const bytes = bitmap(currentRgb);
        return {
          id: "capture" + captures,
          host: "test-host",
          session: "test-session",
          target:
            mode === "captured-target-change" && preferredCalls
              ? params.handle + 1
              : params.handle,
          pid: mode === "captured-pid-change" && preferredCalls ? pid + 1 : pid,
          at: Date.now(),
          revision: hash(bytes),
          image: bytes.toString("base64"),
          focused: focus,
          title: "Protocol fixture",
          frame: { x: frameX, y: 200, width: 3, height: 2, scale: 1 },
        };
      }
      throw new Error("Unexpected host operation " + method);
    },
    async close() {},
  };
  const adapter = await new WindowsAdapter(
    store,
    false,
    client as unknown as NativeClient,
  ).start(1);
  (
    adapter as unknown as { preferOculix: boolean; oculix: OculixBackend }
  ).preferOculix = mode !== "disabled";
  (adapter as unknown as { oculix: OculixBackend }).oculix = backend;
  return {
    adapter,
    store,
    abort,
    calls,
    counts: () => ({ captures, preferredCalls }),
    preferredImage: () => preferredBytes,
    nativeImage: () => bitmapToPng(bitmap(currentRgb)),
  };
}

test("preferred adapter capture selects exact Oculix pixels and persists provenance while retaining native observation authority", async () => {
  const f = await fixture("valid");
  try {
    const observation = await f.adapter.observe(f.abort.signal);
    assert.equal(observation.id, "capture3");
    assert.equal(observation.backend, "rust-win32-v1");
    assert.equal(
      observation.facts.captureBackend,
      "oculix-mcp:02ea8844483a83a2963db8016cd7ad421e15bc91",
    );
    assert.equal(
      observation.facts.captureStatus,
      "preferred-full-rgb-confirmed",
    );
    assert.deepEqual(
      f.store.artifactRead(observation.image!),
      f.preferredImage(),
    );
    assert.notDeepEqual(f.preferredImage(), f.nativeImage());
    assert.equal(observation.revision, hash(bitmap(rgb)));
    assert.equal(observation.facts.captureImageSha256, observation.image);
    const provenance = f.store.get<any>("backend", "last-capture");
    assert.equal(provenance.observationId, observation.id);
    assert.equal(provenance.nativeRevision, observation.revision);
    assert.equal(provenance.imageSha256, observation.image);
    assert.equal(f.counts().preferredCalls, 1);
    assert.equal(observation.facts.captureFallbackReason, undefined);
    assert.equal(f.calls.includes("execute"), false);
  } finally {
    await f.adapter.close();
    f.store.close();
  }
});

test("unavailable, malformed, mismatched or wrong-size preferred captures fall back only to a freshly coherent native frame", async () => {
  for (const mode of [
    "unavailable",
    "malformed",
    "mismatch",
    "dimensions",
    "disabled",
    "absent",
  ]) {
    const f = await fixture(mode);
    try {
      const observation = await f.adapter.observe();
      assert.equal(observation.facts.captureBackend, "rust-win32-v1");
      assert.deepEqual(
        f.store.artifactRead(observation.image!),
        f.nativeImage(),
      );
      assert.equal(
        f.counts().preferredCalls,
        ["disabled", "absent"].includes(mode) ? 0 : 1,
      );
      assert.equal(
        observation.id,
        ["disabled", "absent"].includes(mode) ? "capture2" : "capture3",
      );
      assert.equal(
        observation.facts.captureStatus,
        mode === "disabled"
          ? "native-selected"
          : mode === "absent"
            ? "unavailable-native-fallback"
            : "invalid-native-fallback",
      );
      const provenance = f.store.get<any>("backend", "last-capture");
      assert.equal(provenance.captureBackend, "rust-win32-v1");
      assert.equal(provenance.imageSha256, observation.image);
      const expectedReason: Record<string, string | undefined> = {
        unavailable: "backend-unavailable",
        malformed: "malformed-capture",
        mismatch: "pixel-mismatch",
        dimensions: "dimension-mismatch",
        disabled: undefined,
        absent: "capability-unavailable",
      };
      assert.equal(
        observation.facts.captureFallbackReason,
        expectedReason[mode],
      );
      assert.equal(provenance.captureFallbackReason, expectedReason[mode]);
      assert.equal(
        JSON.stringify(provenance).includes("private arbitrary error detail"),
        false,
      );
      if (["mismatch", "dimensions"].includes(mode))
        assert.notEqual(provenance.imageSha256, hash(f.preferredImage()));
      assert.equal(f.calls.includes("execute"), false);
    } finally {
      await f.adapter.close();
      f.store.close();
    }
  }
});

test("changes during preferred capture discard the complete interval and never dispatch input", async () => {
  for (const mode of [
    "pixel-change",
    "text-change",
    "controls-change",
    "focus-change",
    "frame-change",
    "pid-change",
    "target-change",
    "captured-target-change",
    "captured-pid-change",
  ]) {
    const f = await fixture(mode);
    try {
      if (mode === "target-change") {
        const observed = await f.adapter.observe();
        assert.equal(observed.facts.windowHandle, 2);
        assert.equal(observed.facts.ownedDialog, true);
        assert.equal(observed.id, "capture5");
      } else
        await assert.rejects(
          () => f.adapter.observe(),
          /kept changing|changed process|target\/PID mismatch/,
        );
      if (mode !== "target-change")
        assert.equal(f.store.get("backend", "last-capture"), undefined);
      assert.ok(f.counts().preferredCalls <= 12);
      assert.equal(f.calls.includes("execute"), false);
    } finally {
      await f.adapter.close();
      f.store.close();
    }
  }
});

test("preferred capture does not grant Oculix input and guarded native actions retain the exact caller contract", async () => {
  const f = await fixture("valid");
  try {
    const observation = await f.adapter.observe();
    const generation = await f.adapter.acquire("owner");
    const action = {
      schemaVersion: 1 as const,
      id: "owned-click",
      runId: "owner",
      requester: "local-user",
      host: f.adapter.host,
      session: f.adapter.session,
      target: f.adapter.identity,
      observationId: observation.id,
      revision: observation.revision,
      frame: observation.frame,
      operation: "click",
      args: { x: 1, y: 1 },
      deadline: Date.now() + 1000,
      scope: "edit",
      generation,
    };
    const receipt = await f.adapter.execute(action);
    assert.equal(receipt.phase, "acknowledged");
    assert.equal(receipt.backend, "rust-win32-v1");
    assert.equal(receipt.actionId, action.id);
    assert.equal(receipt.runId, action.runId);
    assert.equal(f.counts().preferredCalls, 1);
    assert.equal(f.calls.filter((method) => method === "execute").length, 1);
    await f.adapter.release("owner");
    await assert.rejects(
      () => f.adapter.execute({ ...action, id: "unowned" }),
      /Invalid input lease/,
    );
    assert.equal(f.counts().preferredCalls, 1);
  } finally {
    await f.adapter.close();
    f.store.close();
  }
});

test("preferred capture deadlines and cancellation reject rather than returning native fallback or making another host call", async () => {
  for (const mode of ["deadline", "cancel"]) {
    const f = await fixture(mode);
    try {
      await assert.rejects(
        () => f.adapter.observe(f.abort.signal),
        mode === "deadline"
          ? (error: unknown) => error instanceof OculixDeadlineError
          : /abort/i,
      );
      assert.equal(f.counts().captures, 2);
      assert.equal(f.counts().preferredCalls, 1);
      assert.equal(f.store.get("backend", "last-capture"), undefined);
      assert.equal(f.calls.includes("execute"), false);
    } finally {
      await f.adapter.close();
      f.store.close();
    }
  }
});

test("PNG decoding shares the existing observation deadline and cannot return a late preferred image or fallback", async () => {
  let elapsed = 0;
  const originalNow = Date.now;
  const f = await fixture("decode-deadline", () => {
    elapsed += 6000;
  });
  Date.now = () => originalNow() + elapsed;
  try {
    await assert.rejects(() => f.adapter.observe(), /capture deadline/);
    assert.equal(f.counts().captures, 2);
    assert.equal(f.counts().preferredCalls, 1);
    assert.equal(f.store.get("backend", "last-capture"), undefined);
    assert.equal(f.calls.includes("execute"), false);
  } finally {
    Date.now = originalNow;
    await f.adapter.close();
    f.store.close();
  }
});
