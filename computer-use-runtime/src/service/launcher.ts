import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { Store, StoreLockedError } from "../storage/index.js";
import { DesktopRouter } from "../adapters/desktop.js";
import { LocalDesktopPlanner } from "../assistant/local.js";
import { Runtime } from "../runtime/index.js";
import { AdaptiveSelector } from "../learner/selector.js";
import { seedForm } from "../skills/index.js";
import { service } from "./index.js";
import {
  copyToken,
  openConsole,
  probeService,
  type ServiceConfig,
} from "./lifecycle.js";

export async function startService(config: ServiceConfig, args: string[]) {
  let store: Store;
  try {
    store = new Store(config.root);
  } catch (error) {
    if (!(error instanceof StoreLockedError)) throw error;
    if (!(await probeService(config)))
      throw new Error(
        `Process ${error.pid} owns ${error.root}, but the service is not ready at ${config.url}. Wait for startup or use Ctrl+C in that process's terminal. Do not delete a live lock.`,
      );
    console.log(
      `Computer use runtime is already running.\nOpen ${config.url}\nShow token: npm run token\nStop: npm stop\nNo second coordinator was started.`,
    );
    if (args.includes("--open")) await openConsole(config.url);
    return;
  }
  const adapter = new DesktopRouter(store);
  const selector = new AdaptiveSelector(store, adapter.capabilities);
  const runtime = new Runtime(
    store,
    adapter,
    undefined,
    undefined,
    selector.select.bind(selector),
    new LocalDesktopPlanner(store),
  );
  let app: Awaited<ReturnType<typeof service>> | undefined;
  try {
    const token = store.token();
    writeFileSync(config.tokenPath, token, { mode: 0o600 });
    // Preserve existing default client examples without sharing tokens across custom stores.
    if (config.root === resolve(".data/service"))
      writeFileSync(resolve(".data/service.token"), token, { mode: 0o600 });
    await adapter.start(!args.includes("--headed"));
    if (!runtime.registry.list().length) runtime.registry.put(seedForm());
    await runtime.recover();
    app = await service(runtime);
    let terminal: ReturnType<typeof createInterface> | undefined;
    let shutdown: Promise<void> | undefined;
    const stop = () =>
      (shutdown ||= app!.close().catch((error) => {
        console.error("Shutdown failed:", String(error));
        process.exitCode = 1;
      }));
    const onSignal = () => {
      void stop();
    };
    const metadata = {
      pid: process.pid,
      port: config.port,
      startedAt: new Date().toISOString(),
    };
    app.addHook("preClose", async () => {
      console.log(
        "Stopping runtime. Pausing tasks and closing desktop, browser and training workers...",
      );
    });
    app.addHook("onClose", async () => {
      terminal?.close();
      process.stdin.pause();
      for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const)
        process.removeListener(signal, onSignal);
      await selector.close();
      writeFileSync(
        config.metadataPath,
        JSON.stringify({
          ...metadata,
          status: "stopped",
          stoppedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      console.log(
        "Runtime stopped. Saved tasks and token are retained. Start again with npm start.",
      );
    });
    await app.listen({ host: "127.0.0.1", port: config.port });
    writeFileSync(
      config.metadataPath,
      JSON.stringify({ ...metadata, status: "running" }),
      { mode: 0o600 },
    );
    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const)
      process.on(signal, onSignal);
    console.log(
      `\nComputer use runtime is ready.\nOpen: ${config.url}\nToken file: ${config.tokenPath}\n\nIn another terminal:\n  npm run token           Show your login token\n  npm run token -- --copy Copy it to the clipboard\n  npm run open            Open the console\n  npm run status          Check the service\n  npm stop                Shut down gracefully\n  npm restart             Stop and start again\n\nHere, type open, token, copy, status or stop, then press Enter.\nCtrl+C also stops the runtime. Keep this terminal open while using the app.\n`,
    );
    if (args.includes("--show-token")) console.log(token);
    terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
    });
    terminal.on("SIGINT", onSignal);
    terminal.on("line", (line) => {
      void (async () => {
        switch (line.trim().toLowerCase()) {
          case "stop":
          case "quit":
          case "exit":
            await stop();
            break;
          case "token":
            console.log(token);
            break;
          case "copy":
            copyToken(token);
            console.log(
              "Token copied. Paste it into Local service token in the console.",
            );
            break;
          case "open":
            await openConsole(config.url);
            break;
          case "status":
            console.log(`Running at ${config.url}, process ${process.pid}.`);
            break;
          case "":
            break;
          default:
            console.log(
              "Commands: open, token, copy, status, stop. Press Enter after the command.",
            );
        }
      })().catch((error) => console.error(String(error)));
    });
    if (args.includes("--open"))
      await openConsole(config.url).catch((error) =>
        console.error(String(error)),
      );
  } catch (error: any) {
    if (app) await app.close();
    else {
      await selector.close();
      await runtime.close();
    }
    if (error.code === "EADDRINUSE")
      throw new Error(
        `Port ${config.port} is already used by another process. Check npm run status, or choose another CUR_PORT. This startup released its data-store lock.`,
      );
    throw error;
  }
}
