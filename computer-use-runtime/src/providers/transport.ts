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

export function localFetch(url: string, options: RequestInit = {}) {
  localEndpoint(url);
  return fetch(url, { ...options, redirect: "error" });
}

export const PROVIDER_METADATA_BYTES = 1024 * 1024;
export const PROVIDER_OUTPUT_BYTES = 4 * 1024 * 1024;

export function rejectProviderResponse(
  response: Response,
  message: string,
): never {
  void response.body?.cancel().catch(() => {});
  throw new Error(message);
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
    const result: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(value),
    );
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
    rejectProviderResponse(
      response,
      "Local model readiness HTTP " + response.status,
    );
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
      "Local model does not advertise " + required + " capability",
    );
  return data;
}
