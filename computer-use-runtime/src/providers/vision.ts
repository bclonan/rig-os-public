import {
  localEndpoint,
  localFetch,
  localOllamaReady,
  providerJson,
  PROVIDER_OUTPUT_BYTES,
  rejectProviderResponse,
} from "./transport.js";
import { Ajv } from "ajv";
import { hash, canonical } from "../storage/index.js";
import type { Observation } from "../contracts/index.js";
import { ScopedEvidenceCache } from "../predicates/cache.js";
const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    visibleSubject: { type: "string" },
    recognizable: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["visibleSubject", "recognizable", "reason"],
};
export class LocalVisionAssessor {
  constructor(
    readonly model: string,
    readonly endpoint = "http://127.0.0.1:11434",
  ) {
    this.endpoint = localEndpoint(endpoint);
  }
  async assess(
    subject: string,
    png: Buffer,
    signal?: AbortSignal,
    cached?: { cache: ScopedEvidenceCache<any>; observation: Observation },
  ) {
    const combined = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
      : AbortSignal.timeout(120000);
    const metadata = await localOllamaReady(
      this.endpoint,
      this.model,
      "vision",
      combined,
    );
    const key = hash(
      canonical({
        endpoint: this.endpoint,
        model: this.model,
        metadataHash: hash(canonical(metadata)),
        subject,
        imageHash: hash(png),
        detector: "canvas-assessment-v1",
      }),
    );
    const prior = cached?.cache.get(key, cached.observation);
    if (prior)
      return {
        ...prior.value,
        cacheHit: true,
        evaluatedAt: prior.evaluatedAt,
        sourceObservationId: prior.sourceObservationId,
        providerCalls: 0,
      };
    const start = performance.now();
    const response = await localFetch(this.endpoint + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: combined,
      body: JSON.stringify({
        model: this.model,
        stream: false,
        think: false,
        format: schema,
        options: { temperature: 0, num_predict: 500, num_ctx: 4096 },
        messages: [
          {
            role: "user",
            content: `Independently inspect ONLY this target canvas. Does it contain a recognizable drawing of a ${subject}? A blank canvas, dots, one line, words naming the subject, a wrong subject or incomplete disconnected strokes do not qualify. Describe what is actually visible. Return JSON.`,
            images: [png.toString("base64")],
          },
        ],
      }),
    });
    if (!response.ok)
      rejectProviderResponse(
        response,
        "Vision provider HTTP " + response.status,
      );
    const body: any = await providerJson(
      response,
      PROVIDER_OUTPUT_BYTES,
      combined,
    );
    const assessment = JSON.parse(body.message.content);
    if (!new Ajv({ strict: false }).validate(schema, assessment))
      throw new Error("Vision assessment schema rejected");
    const result = {
      kind: "semantic-assessment",
      model: this.model,
      assessment,
      independentlyVerifiedCompletion: false,
      calibrated: false,
      latencyMs: performance.now() - start,
      cacheHit: false,
      providerCalls: 1,
    };
    if (cached && cached.observation.facts.nativeEventsAvailable === true) {
      const region = JSON.parse(String(cached.observation.facts.canvasBounds));
      cached.cache.remember(
        key,
        result,
        cached.observation,
        ["canvasImage", "canvasBounds"],
        region,
      );
    }
    return result;
  }
}
