import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RuntimeClient } from "../src/sdk/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import type { RunEvent } from "../src/contracts/index.js";

/** Run the same example against an explicitly supplied local runtime client. */
export async function runGenericExample(
  client: RuntimeClient,
  name = "Generic SDK " + Date.now(),
  onEvent: (event: RunEvent) => void = () => {},
) {
  const caps = await client.request("/api/capabilities");
  const task = structuredTask(
    "Set display name",
    { host: caps.host, session: caps.session, identity: caps.identity },
    { name },
  );
  await client.submit(task);
  const signal = new AbortController();
  const deadline = setTimeout(() => signal.abort(), task.budgets.deadlineMs);
  const events: RunEvent[] = [];
  try {
    for await (const event of client.events(0, signal.signal)) {
      if (event.runId !== task.id) continue;
      events.push(event);
      onEvent(event);
      if (["completed", "interrupted"].includes(event.type)) {
        signal.abort();
        break;
      }
    }
  } finally {
    clearTimeout(deadline);
    signal.abort();
  }
  const run = await client.status(task.id);
  if (run.status !== "succeeded")
    throw new Error("Generic example did not succeed: " + run.status);
  return { task, run, events };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const client = new RuntimeClient(
    process.env.CUR_URL || "http://127.0.0.1:4317",
    readFileSync(
      process.env.CUR_TOKEN_FILE || ".data/service.token",
      "utf8",
    ).trim(),
  );
  await runGenericExample(client, undefined, (event) =>
    console.log(event.seq, event.type),
  );
}
