const providerRecovery = {
  "request-rejected":
    "Check the local provider's version and model configuration, or choose another provider. No desktop action was sent.",
  "not-installed":
    "The selected model is not installed. Refresh the model list and choose an installed model. No desktop action was sent.",
  "vision-unavailable":
    "This model cannot read screenshots. Choose a vision model for drawing or pointer tasks. No desktop action was sent.",
  "context-too-large":
    "The observation exceeds this model's context window. Choose a model with a larger context window or narrow the task to one window. No desktop action was sent.",
  "thinking-rejected":
    "This model rejected the thinking setting. Choose another model or update the local provider. No desktop action was sent.",
  "schema-rejected":
    "The local provider rejected the response schema. Update the local provider or choose another model. No desktop action was sent.",
  "resource-unavailable":
    "The local provider could not load this model. Free memory or choose a smaller model. No desktop action was sent.",
  "service-failed":
    "The local model service failed. Restart that service or choose another provider. No desktop action was sent.",
  "service-unavailable":
    "The local model service is not running. Start Ollama or the configured local provider, then refresh the model list.",
  "transport-failed":
    "The local model request failed. Check the configured loopback service. Redirects are not allowed.",
} as const;
export type ProviderDiagnosticCategory = keyof typeof providerRecovery;

/** Only fixed internal categories and validated status codes can cross this boundary. */
export class ProviderDiagnosticError extends Error {
  readonly category: ProviderDiagnosticCategory;
  readonly httpStatus?: number;
  constructor(
    category: ProviderDiagnosticCategory,
    status?: number,
    operation = "Local provider",
  ) {
    const safeCategory = Object.hasOwn(providerRecovery, category)
      ? category
      : "request-rejected";
    const safeOperation = [
      "Ollama generation",
      "Provider",
      "Vision provider",
      "Local model readiness",
    ].includes(operation)
      ? operation
      : "Local provider";
    const safeStatus =
      Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599
        ? status
        : undefined;
    super(
      (safeStatus === undefined
        ? ""
        : `${safeOperation} HTTP ${safeStatus}. `) +
        providerRecovery[safeCategory],
    );
    this.category = safeCategory;
    this.httpStatus = safeStatus;
  }
}

/** Local observations must never leave the configured loopback service. */
export function localEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Local provider requires an HTTP loopback endpoint without credentials, query or fragment",
    );
  return url.href.replace(/\/$/, "");
}

export async function localFetch(url: string, options: RequestInit = {}) {
  localEndpoint(url);
  try {
    return await fetch(url, { ...options, redirect: "error" });
  } catch (error) {
    options.signal?.throwIfAborted();
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code === "ECONNREFUSED")
      throw new ProviderDiagnosticError("service-unavailable");
    throw new ProviderDiagnosticError("transport-failed");
  }
}

export const PROVIDER_METADATA_BYTES = 1024 * 1024;
export const PROVIDER_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Newer Ollama models can require named thinking levels rather than booleans. */
export function ollamaThinking(
  metadata: Record<string, unknown>,
  requested = false,
): boolean | string | undefined {
  const info = metadata.thinking;
  if (info && typeof info === "object" && !Array.isArray(info)) {
    const thinking = info as Record<string, unknown>;
    if (Array.isArray(thinking.values)) {
      if (thinking.values.includes(requested)) return requested;
      if (!requested) return undefined;
      if (
        typeof thinking.default === "string" &&
        thinking.values.includes(thinking.default)
      )
        return thinking.default;
      throw new Error(
        "This local model does not advertise the requested thinking capability. Disable thinking or choose another model.",
      );
    }
  }
  const supported =
    Array.isArray(metadata.capabilities) &&
    metadata.capabilities.includes("thinking");
  if (supported) return requested;
  if (requested)
    throw new Error(
      "This local model does not advertise thinking capability. Disable thinking or choose another model.",
    );
  return undefined;
}

export function modelJson(content: unknown): unknown {
  if (typeof content !== "string" || !content.trim())
    throw new Error(
      "The model returned no final answer within its token budget. Choose another model or shorten the task.",
    );
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(
      "The model returned invalid JSON. Choose another model or retry this planning step. No desktop action was sent.",
    );
  }
}

export function rejectProviderResponse(
  response: Response,
  message: string,
): never {
  void response.body?.cancel().catch(() => {});
  throw new Error(message);
}

/** Classify bounded server errors without returning private prompts or paths. */
export async function rejectModelResponse(
  response: Response,
  operation: string,
  signal?: AbortSignal,
): Promise<never> {
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(500)])
    : AbortSignal.timeout(500);
  let detail = "";
  try {
    const body = await providerJson(response, 8192, combined);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const error = (body as Record<string, unknown>).error;
      if (typeof error === "string") detail = error.toLowerCase();
    }
  } catch {
    // A malformed, oversized or stalled error body has no diagnostic authority.
  }
  signal?.throwIfAborted();
  let recovery =
    "Check the local provider's version and model configuration, or choose another provider. No desktop action was sent.";
  if (response.status === 404 || /model.+not found|pull.+model/.test(detail))
    recovery =
      "The selected model is not installed. Refresh the model list and choose an installed model. No desktop action was sent.";
  else if (
    /image|vision|multimodal/.test(detail) &&
    /support|capab/.test(detail)
  )
    recovery =
      "This model cannot read screenshots. Choose a vision model for drawing or pointer tasks. No desktop action was sent.";
  else if (/context|input.+long|prompt.+long/.test(detail))
    recovery =
      "The observation exceeds this model's context window. Choose a model with a larger context window or narrow the task to one window. No desktop action was sent.";
  else if (
    /thinking|think/.test(detail) &&
    /support|invalid|require/.test(detail)
  )
    recovery =
      "This model rejected the thinking setting. Choose another model or update the local provider. No desktop action was sent.";
  else if (/grammar|json schema|schema|format/.test(detail))
    recovery =
      "The local provider rejected the response schema. Update the local provider or choose another model. No desktop action was sent.";
  else if (/memory|alloc|resource|load.+model/.test(detail))
    recovery =
      "The local provider could not load this model. Free memory or choose a smaller model. No desktop action was sent.";
  else if (response.status >= 500)
    recovery =
      "The local model service failed. Restart that service or choose another provider. No desktop action was sent.";
  const category =
    (Object.keys(providerRecovery) as ProviderDiagnosticCategory[]).find(
      (key) => providerRecovery[key] === recovery,
    ) ?? "request-rejected";
  throw new ProviderDiagnosticError(category, response.status, operation);
}

/** Limit bytes before decoding, including servers that ignore token limits. */
export async function providerJson(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader();
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(signal?.reason ?? new Error("Provider response aborted"));
  });
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("Invalid provider byte budget");
    const length = response.headers.get("content-length");
    if (length && /^\d+$/.test(length) && Number(length) > maxBytes)
      throw new Error("Provider response exceeds byte budget");
    if (!reader) throw new Error("Provider response has no body");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      signal?.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes)
        throw new Error("Provider response exceeds byte budget");
      chunks.push(next.value);
    }
    const value = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      value.set(chunk, offset);
      offset += chunk.length;
    }
    signal?.throwIfAborted();
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      throw new Error("Provider returned invalid encoded data");
    }
    let result: unknown;
    try {
      result = JSON.parse(decoded);
    } catch {
      throw new Error("Provider returned invalid JSON");
    }
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

/** A loopback Ollama server can proxy cloud models. Inspect before sending data. */
export async function localOllamaReady(
  endpoint: string,
  model: string,
  modality: "text" | "vision" = "text",
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!model.trim() || /(?:[-:]cloud)(?:$|:)/i.test(model))
    throw new Error("Cloud models are unavailable for private local tasks");
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
    : AbortSignal.timeout(10000);
  const response = await localFetch(localEndpoint(endpoint) + "/api/show", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
    signal: combined,
  });
  if (!response.ok)
    await rejectModelResponse(response, "Local model readiness", combined);
  const metadata = await providerJson(
    response,
    PROVIDER_METADATA_BYTES,
    combined,
  );
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Local model readiness metadata rejected");
  const data = metadata as Record<string, unknown>;
  if (
    data.remote_host ||
    data.remote_model ||
    data.cloud === true ||
    data.remote === true ||
    (typeof data.modelfile === "string" &&
      /^\s*(?:REMOTE_HOST|FROM\s+\S*(?:[-:]cloud)(?:\s|$))/im.test(
        data.modelfile,
      ))
  )
    throw new Error(
      "Cloud-backed models are unavailable for private local tasks",
    );
  const required = modality === "vision" ? "vision" : "completion";
  if (
    !Array.isArray(data.capabilities) ||
    !data.capabilities.includes(required)
  )
    throw new Error(
      required === "vision"
        ? "This local model does not advertise vision capability. Choose a vision model for drawing or pointer tasks."
        : "This local model does not advertise completion capability. Choose another installed model.",
    );
  return data;
}
