import type { TaskContract, RunEvent } from "../contracts/index.js";
export class RuntimeClient {
  constructor(
    readonly url: string,
    readonly token: string,
  ) {}
  async request(
    path: string,
    method = "GET",
    body?: unknown,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<any> {
    const r = await fetch(this.url + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(130000),
      headers: {
        authorization: "Bearer " + this.token,
        "content-type": "application/json",
        "x-correlation-id": crypto.randomUUID(),
        "idempotency-key": idempotencyKey,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
  submit(task: TaskContract, key = task.id) {
    return this.request("/api/tasks", "POST", task, key);
  }
  async artifactOutput(id: string) {
    const response = await fetch(
      this.url + "/api/artifact-tasks/" + encodeURIComponent(id) + "/download",
      {
        headers: { authorization: "Bearer " + this.token },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw new Error(await response.text());
    return {
      content: await response.text(),
      type: response.headers.get("content-type") || "text/plain",
    };
  }
  status(id: string) {
    return this.request("/api/tasks/" + encodeURIComponent(id));
  }
  advice(id: string) {
    return this.request("/api/tasks/" + encodeURIComponent(id) + "/advice");
  }
  drawingPlan(
    request: { goal: string; model: string; handle: number; pid: number },
    key = crypto.randomUUID(),
  ) {
    return this.request("/api/drawing-plans", "POST", request, key);
  }
  executeDrawing(id: string, key = id) {
    return this.request(
      "/api/drawing-plans/" + encodeURIComponent(id) + "/execute",
      "POST",
      {},
      key,
    );
  }
  assessCanvas(id: string, subject: string, model: string) {
    return this.request(
      "/api/desktop/tasks/" + encodeURIComponent(id) + "/assess",
      "POST",
      { subject, model },
    );
  }
  control(id: string, command: string) {
    return this.request(
      "/api/tasks/" + encodeURIComponent(id) + "/control",
      "POST",
      { command },
    );
  }
  async *events(after = 0, signal?: AbortSignal): AsyncGenerator<RunEvent> {
    while (!signal?.aborted) {
      try {
        const response = await fetch(this.url + "/api/events?after=" + after, {
          redirect: "error",
          headers: { authorization: "Bearer " + this.token },
          signal,
        });
        if (response.status === 401 || response.status === 403)
          throw new Error("Event stream authorization rejected");
        if (!response.ok || !response.body)
          throw new Error("Event stream unavailable");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let at;
            while ((at = buffer.indexOf("\n\n")) >= 0) {
              const chunk = buffer.slice(0, at);
              buffer = buffer.slice(at + 2);
              const data = chunk
                .split("\n")
                .find((l) => l.startsWith("data: "));
              if (data) {
                const event = JSON.parse(data.slice(6)) as RunEvent;
                if (event.seq > after) {
                  after = event.seq;
                  yield event;
                }
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch (error) {
        if (signal?.aborted) return;
        if (String(error).includes("authorization rejected")) throw error;
      }
      if (signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 500);
        signal?.addEventListener("abort", finish, { once: true });
        if (signal?.aborted) finish();
      });
    }
  }
}
