import { randomUUID } from "node:crypto";
import { readFile, open, unlink } from "node:fs/promises";
import { join } from "node:path";

const lanes = new Map<string, Promise<void>>();

/** All cooperating readers and writers use one root lease. This is not an OS
 * sandbox against another process with the same filesystem authority. */
export async function withWorkspaceLease<T>(
  root: string,
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const previous = lanes.get(root) ?? Promise.resolve();
  let started = false;
  const result = previous.then(async () => {
    signal.throwIfAborted();
    started = true;
    const path = join(root, ".cur-workspace.lock");
    const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          "Workspace is owned by another operation. Use an exclusive workspace; inspect a stale lease before removing it.",
        );
      throw error;
    }
    try {
      await handle.writeFile(owner);
      await handle.sync();
    } catch (error) {
      await handle.close();
      throw error;
    }
    await handle.close();
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      if ((await readFile(path, "utf8")) !== owner)
        throw new Error("Workspace lease changed; ownership cleanup refused");
      await unlink(path);
    }
  });
  const tail = result.then(
    () => {},
    () => {},
  );
  lanes.set(root, tail);
  void tail.then(() => {
    if (lanes.get(root) === tail) lanes.delete(root);
  });
  // Cancellation settles the caller while the queued operation remains behind
  // its predecessor. The operation checks the same signal before taking a lease.
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      if (!started) reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    result.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
