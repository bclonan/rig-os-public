import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { hash } from "../storage/index.js";

export function processAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error.code !== "ESRCH";
  }
}
export function readOwner(root: string): number | undefined {
  try {
    const pid = Number(readFileSync(resolve(root, "coordinator.lock"), "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error(
        "The coordinator lock is not ready. Retry after startup finishes.",
      );
    return pid;
  } catch (error: any) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
export function serviceConfig() {
  const root = resolve(process.env.CUR_DATA || ".data/service");
  let savedPort: number | undefined;
  try {
    savedPort = JSON.parse(
      readFileSync(resolve(root, "service.json"), "utf8"),
    ).port;
  } catch {}
  const port = Number(process.env.CUR_PORT || savedPort || 4317);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("CUR_PORT must be a whole number from 1 to 65535.");
  return {
    root,
    port,
    url: `http://127.0.0.1:${port}`,
    tokenPath: resolve(root, "service.token"),
    metadataPath: resolve(root, "service.json"),
  };
}
export type ServiceConfig = ReturnType<typeof serviceConfig>;
export function readServiceToken(config: ServiceConfig) {
  const samePath = (left: string, right: string) =>
    process.platform === "win32"
      ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
      : resolve(left) === resolve(right);
  const legacy = samePath(config.root, resolve(".data/service"))
    ? resolve(".data/service.token")
    : undefined;
  const path = existsSync(config.tokenPath) ? config.tokenPath : legacy;
  if (!path || !existsSync(path))
    throw new Error("No local token exists yet. Run npm start first.");
  const token = readFileSync(path, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error(
      "The local token file is invalid. Restart the service to restore it.",
    );
  return token;
}
export async function probeService(config: ServiceConfig) {
  const owner = readOwner(config.root);
  if (!owner || !processAlive(owner)) return undefined;
  try {
    const response = await fetch(config.url + "/api/service", {
      redirect: "error",
      headers: { authorization: "Bearer " + readServiceToken(config) },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return undefined;
    const status = (await response.json()) as any;
    if (
      status.name !== "computer-use-runtime" ||
      status.pid !== owner ||
      status.storeId !== hash(config.root)
    )
      return undefined;
    return status as {
      name: string;
      pid: number;
      storeId: string;
      status: string;
      activeTasks: number;
    };
  } catch {
    return undefined;
  }
}
export async function stopService(config: ServiceConfig) {
  const owner = readOwner(config.root);
  if (!owner || !processAlive(owner)) return false;
  if (!(await probeService(config)))
    throw new Error(
      `Process ${owner} owns this store, but its authenticated service is unavailable at ${config.url}. Use Ctrl+C or enter stop in its terminal. An older running version must be stopped from its terminal once before using npm stop.`,
    );
  const response = await fetch(config.url + "/api/service/shutdown", {
    redirect: "error",
    method: "POST",
    headers: {
      authorization: "Bearer " + readServiceToken(config),
      "content-type": "application/json",
      "x-correlation-id": crypto.randomUUID(),
      "idempotency-key": crypto.randomUUID(),
    },
    body: "{}",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(`Shutdown was rejected with HTTP ${response.status}.`);
  await response.arrayBuffer();
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const current = readOwner(config.root);
    if (!current || !processAlive(current)) return true;
    if (current !== owner)
      throw new Error(
        "A different coordinator started while shutdown was pending. It was not stopped.",
      );
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    "Shutdown is still pending. Check the service terminal; the coordinator lock has been preserved.",
  );
}
export function copyToken(token: string) {
  const wayland =
    process.platform === "linux" &&
    (process.env.XDG_SESSION_TYPE === "wayland" ||
      Boolean(process.env.WAYLAND_DISPLAY));
  const command =
    process.platform === "win32"
      ? "clip.exe"
      : process.platform === "darwin"
        ? "pbcopy"
        : wayland
          ? "wl-copy"
          : "xclip";
  const args =
    process.platform === "linux" && !wayland ? ["-selection", "clipboard"] : [];
  const result = spawnSync(command, args, {
    input: token,
    encoding: "utf8",
    windowsHide: true,
    timeout: 3000,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      "Clipboard access failed. Use npm run token to display the token.",
    );
}
export async function openConsole(url: string) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url))
    throw new Error("Only the local console can be opened.");
  const command =
    process.platform === "win32"
      ? "rundll32.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
    child.once("error", () =>
      reject(new Error(`Open ${url} in your browser.`)),
    );
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
