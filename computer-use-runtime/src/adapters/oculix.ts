import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Ajv } from "ajv";
import { readFileSync, appendFileSync } from "node:fs";
import { hash } from "../storage/index.js";
import { inflateSync } from "node:zlib";
export const OCULIX_COMMIT = "02ea8844483a83a2963db8016cd7ad421e15bc91";
export class OculixDeadlineError extends Error {}
export class OculixCaptureError extends Error {}

/** Full RGB validation, with no resizing, masks or approximate comparison. */
export function capturePixels(
  bytes: Buffer,
  deadlineAt?: number,
  signal?: AbortSignal,
) {
  const checkDeadline = () => {
    signal?.throwIfAborted();
    if (deadlineAt !== undefined && Date.now() >= deadlineAt)
      throw new OculixDeadlineError(
        "Oculix capture deadline during PNG decoding",
      );
  };
  checkDeadline();
  if (
    bytes.length > 16 * 1024 * 1024 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("Invalid or oversized capture PNG");
  let width = 0,
    height = 0,
    channels = 0,
    ended = false;
  const compressed: Buffer[] = [];
  const checksum = (value: Buffer) => {
    let crc = 0xffffffff;
    for (let index = 0; index < value.length; index++) {
      if (index % 4096 === 0) checkDeadline();
      const byte = value[index];
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  for (let offset = 8; offset < bytes.length;) {
    checkDeadline();
    if (offset + 12 > bytes.length) throw new Error("Truncated capture PNG");
    const length = bytes.readUInt32BE(offset),
      end = offset + length + 12;
    if (end > bytes.length) throw new Error("Truncated capture PNG chunk");
    const name = bytes.toString("ascii", offset + 4, offset + 8),
      data = bytes.subarray(offset + 8, end - 4);
    if (
      checksum(bytes.subarray(offset + 4, end - 4)) !==
      bytes.readUInt32BE(end - 4)
    )
      throw new Error("Capture PNG checksum mismatch");
    if (name === "IHDR") {
      if (offset !== 8 || length !== 13 || width)
        throw new Error("Invalid capture PNG header");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0;
      if (
        !width ||
        !height ||
        width > 8192 ||
        height > 8192 ||
        !channels ||
        (width * channels + 1) * height > 64 * 1024 * 1024 ||
        data[8] !== 8 ||
        data[10] ||
        data[11] ||
        data[12]
      )
        throw new Error("Unsupported capture PNG encoding");
    } else if (name === "IDAT") {
      if (!width || ended) throw new Error("Invalid capture PNG ordering");
      compressed.push(data);
    } else if (name === "IEND") {
      if (length || end !== bytes.length)
        throw new Error("Invalid capture PNG trailer");
      ended = true;
    } else throw new Error("Unsupported capture PNG chunk");
    offset = end;
  }
  if (!ended || !compressed.length) throw new Error("Incomplete capture PNG");
  const stride = width * channels,
    expected = (stride + 1) * height;
  const filtered = inflateSync(Buffer.concat(compressed), {
    maxOutputLength: expected,
  });
  checkDeadline();
  if (filtered.length !== expected)
    throw new Error("Invalid capture PNG scanlines");
  const raw = Buffer.alloc(stride * height),
    rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    checkDeadline();
    const filter = filtered[y * (stride + 1)];
    if (filter > 4) throw new Error("Unsupported capture PNG filter");
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x,
        left = x >= channels ? raw[at - channels] : 0,
        above = y ? raw[at - stride] : 0,
        diagonal = y && x >= channels ? raw[at - stride - channels] : 0;
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
      raw[at] = (filtered[y * (stride + 1) + x + 1] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const at = y * stride + x * channels,
        out = (y * width + x) * 3;
      if (channels === 4 && raw[at + 3] !== 255)
        throw new Error("Transparent capture PNG is unavailable");
      raw.copy(rgb, out, at, at + 3);
    }
  }
  checkDeadline();
  return { width, height, rgb };
}

export function oculixCapture(
  result: any,
  deadlineAt?: number,
  signal?: AbortSignal,
) {
  if (result?.isError === true || !Array.isArray(result?.content))
    throw new Error("Oculix returned an invalid capture result");
  const images = result.content.filter((item: any) => item.type === "image");
  if (
    images.length !== 1 ||
    images[0].mimeType !== "image/png" ||
    typeof images[0].data !== "string" ||
    images[0].data.length > 24 * 1024 * 1024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      images[0].data,
    )
  )
    throw new Error("Oculix capture must contain one bounded PNG");
  const bytes = Buffer.from(images[0].data, "base64");
  if (bytes.toString("base64") !== images[0].data)
    throw new Error("Oculix capture base64 rejected");
  const pixels = capturePixels(bytes, deadlineAt, signal);
  return { bytes, ...pixels };
}
// Names and argument mappings are taken from the pinned MCP Java tools, then checked live.
const mappings = {
  click: "oculix_click_at_point",
  type: "oculix_type_text",
  key: "oculix_key_combo",
  scroll: "oculix_scroll",
  observe: "oculix_screenshot",
} as const;
export function checkOculixResult(
  operation: keyof typeof mappings,
  result: any,
  deadlineAt?: number,
  signal?: AbortSignal,
) {
  if (result.isError) throw new Error("Oculix returned an error result");
  if (operation === "observe") {
    return oculixCapture(result, deadlineAt, signal);
  }
  const field = {
    click: "clicked",
    type: "typed",
    key: "pressed",
    scroll: "scrolled",
  }[operation];
  const text = result.content?.find((item: any) => item.type === "text")?.text;
  let outcome: Record<string, unknown>;
  try {
    outcome = JSON.parse(text);
  } catch {
    throw new Error("Oculix returned a malformed operation outcome");
  }
  if (outcome[field] !== true)
    throw new Error("Oculix did not acknowledge " + operation);
}
export class OculixBackend {
  client = new Client({ name: "computer-use-runtime", version: "0.1.0" });
  private transport?: StdioClientTransport;
  private tools = new Map<string, any>();
  async start(java: string, jar: string) {
    this.transport = new StdioClientTransport({
      command: java,
      args: ["-jar", jar, "run"],
      stderr: "pipe",
      env: {
        ...(process.env as Record<string, string>),
        OCULIX_MCP_MODE: "open",
      },
    });
    await this.client.connect(this.transport, { timeout: 15000 });
    this.transport.stderr?.on("data", (d) =>
      appendFileSync("evidence/oculix-stderr.log", d),
    );
    const listing = await this.client.listTools();
    for (const t of listing.tools) this.tools.set(t.name, t);
    return {
      commit: OCULIX_COMMIT,
      jarSha256: hash(readFileSync(jar)),
      tools: listing.tools,
    };
  }
  capabilities() {
    return Object.entries(mappings)
      .filter(
        ([operation, tool]) => operation === "observe" && this.tools.has(tool),
      )
      .map(([op]) => op);
  }
  async execute(
    operation: keyof typeof mappings,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 45000,
  ) {
    if (operation !== "observe")
      throw new Error(
        "Pinned Oculix input tools cannot bind a target and lease at dispatch. Use the guarded native input backend.",
      );
    const name = mappings[operation];
    const schema = this.tools.get(name)?.inputSchema;
    if (!schema) throw new Error(`Oculix capability absent: ${operation}`);
    const ajv = new Ajv({ strict: false });
    if (!ajv.validate(schema, args))
      throw new Error("Oculix schema rejected arguments");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45000)
      throw new Error("Oculix capture deadline rejected");
    const deadlineAt = Date.now() + timeoutMs;
    signal?.throwIfAborted();
    let result;
    try {
      result = await this.client.callTool(
        { name, arguments: args },
        undefined,
        { signal, timeout: timeoutMs },
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === -32001
      )
        throw new OculixDeadlineError("Oculix capture deadline", {
          cause: error,
        });
      throw error;
    }
    signal?.throwIfAborted();
    let capture;
    try {
      capture = checkOculixResult(operation, result, deadlineAt, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof OculixDeadlineError) throw error;
      throw new OculixCaptureError("Oculix capture validation failed", {
        cause: error,
      });
    }
    if (!capture) throw new Error("Oculix capture result unavailable");
    return { backend: "oculix-mcp:" + OCULIX_COMMIT, result, capture };
  }
  async close() {
    await this.client.close();
    await this.transport?.close();
  }
}
