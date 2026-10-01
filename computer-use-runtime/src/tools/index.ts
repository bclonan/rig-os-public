import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { constants, lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { withWorkspaceLease } from "./workspace-lease.js";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonical, hash, type Store } from "../storage/index.js";

export type ToolOperation =
  "research_read" | "workspace_read" | "workspace_write";
export type WorkspaceGrant = {
  /** The trusted caller must exclude unrelated filesystem writers. A grant is
   * application authorization, not isolation from a hostile OS user. */
  root: string;
  /** Required for workspace permissions. The caller owns this directory and
   * excludes writers that do not participate in the root lease. */
  exclusiveRoot?: true;
  allowedOrigins: string[];
  permissions: ToolOperation[];
  maxBytes?: number;
  allowLoopbackResearch?: boolean;
  protectedPaths?: string[];
};
export type ToolRequest = {
  id: string;
  runId: string;
  correlationId: string;
  requester: string;
  operation: ToolOperation;
  args: {
    url?: string;
    path?: string;
    content?: string;
    expectedHash?: string;
  };
  deadline: number;
};
export type ToolResult = {
  schemaVersion: 1;
  id: string;
  runId: string;
  operation: ToolOperation;
  status: "succeeded";
  artifact: string;
  bytes: number;
  sha256: string;
  source: { kind: "web" | "workspace"; location: string; retrievedAt: number };
  content: string;
};

function inside(root: string, path: string) {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep);
}
const protectedPart =
  /^(?:\.git|\.data|\.venv.*|node_modules|evaluation|evaluators?|examiner.*|schemas|models|sealed.*|completion-contract.*)$/i;
const protectedFile =
  /^(?:AGENTS\.md|REQUEST\.md|acceptance(?:[.-].*)?\.json|(?:requirements|release-gate|check-ci|test-prompt-docs)(?:\..*)?|\.cur-workspace\.lock|coordinator\.lock|runtime\.sqlite(?:-.*)?|.*\.token|\.env(?:\..*)?)$/i;
export function safeWorkspacePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    /[\0:%]/.test(value)
  )
    throw new Error("Workspace path must be a bounded relative path");
  const parts = value.split(/[\\/]/);
  if (
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        protectedPart.test(p) ||
        protectedFile.test(p),
    )
  )
    throw new Error("Workspace path is protected or escapes its grant");
  return parts.join(sep);
}

/** Reject private, reserved and local ranges before opening remote research sockets. */
export function publicResearchAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  if (isIP(address) === 6) {
    const s = address.toLowerCase();
    // Global unicast only. IPv4-mapped, link-local, loopback, multicast and ULA fail.
    return (
      /^[23][0-9a-f]{0,3}:/.test(s) &&
      !s.startsWith("2001:db8:") &&
      !s.startsWith("2001:0:")
    );
  }
  return false;
}
async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolvePromise, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export class PermissionedTools {
  readonly grant: WorkspaceGrant;
  private root: string;
  private rootIdentity: BigIntStats;
  private maxBytes: number;
  constructor(
    private readonly store: Store,
    grant: WorkspaceGrant,
  ) {
    if (!isAbsolute(grant.root))
      throw new Error("Workspace grant root must be absolute");
    if (
      grant.permissions.some((permission) => permission !== "research_read") &&
      grant.exclusiveRoot !== true
    )
      throw new Error("Workspace permissions require an exclusiveRoot grant");
    this.root = realpathSync(grant.root);
    this.rootIdentity = lstatSync(this.root, { bigint: true });
    if (!lstatSync(this.root).isDirectory())
      throw new Error("Workspace grant root must exist");
    this.maxBytes = grant.maxBytes ?? 262144;
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      this.maxBytes > 1048576
    )
      throw new Error("Workspace byte budget must be one to 1048576");
    this.grant = structuredClone({ ...grant, root: this.root });
    Object.freeze(this.grant.permissions);
    Object.freeze(this.grant.allowedOrigins);
    Object.freeze(this.grant.protectedPaths);
    Object.freeze(this.grant);
    for (const origin of this.grant.allowedOrigins) {
      const url = new URL(origin);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.origin !== origin ||
        url.username ||
        url.password
      )
        throw new Error("Research grants must contain exact HTTP origins");
    }
  }
  private path(value: unknown) {
    const root = lstatSync(this.root, { bigint: true });
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.dev !== this.rootIdentity.dev ||
      root.ino !== this.rootIdentity.ino
    )
      throw new Error(
        "Workspace root identity changed; a new grant is required",
      );
    const relativePath = safeWorkspacePath(value);
    const path = resolve(this.root, relativePath);
    if (!inside(this.root, path))
      throw new Error("Workspace path escapes grant");
    for (const blocked of this.grant.protectedPaths ?? []) {
      const protectedPath = resolve(this.root, blocked);
      if (path === protectedPath || inside(protectedPath, path))
        throw new Error("Workspace path is protected by its grant");
    }
    let current = this.root;
    for (const part of relativePath.split(sep)) {
      current = join(current, part);
      try {
        const entry = lstatSync(current);
        if (
          entry.isSymbolicLink() ||
          (entry.isFile() && entry.nlink !== 1) ||
          !inside(this.root, realpathSync(current))
        )
          throw new Error(
            "Workspace symlink or hardlink paths are unavailable",
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { path, relativePath };
  }
  private checkedFile(value: unknown, handle: FileHandle, opened: BigIntStats) {
    const target = this.path(value);
    const current = lstatSync(target.path, { bigint: true });
    if (
      !opened.isFile() ||
      !current.isFile() ||
      opened.nlink !== 1n ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    )
      throw new Error("Workspace opened file does not match the granted path");
    // Linux supplies a handle path independent of namespace lookups. Other
    // hosts also compare the exact opened identity and require exclusive roots.
    if (
      process.platform === "linux" &&
      !inside(this.root, realpathSync("/proc/self/fd/" + handle.fd))
    )
      throw new Error("Workspace opened handle is outside its grant");
    this.path(value);
    return target;
  }
  async execute(
    request: ToolRequest,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (
      !Number.isFinite(request.deadline) ||
      request.deadline > Date.now() + 120000
    )
      throw new Error("Tool request identity or deadline rejected");
    if (request.operation !== "research_read") {
      const deadline = Number.isFinite(request.deadline)
        ? request.deadline
        : Date.now();
      const bounded = signal
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          ])
        : AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      this.path(request.args.path);
      return withWorkspaceLease(
        this.root,
        () => this.executeOwned(request, bounded),
        bounded,
      );
    }
    return this.executeOwned(request, signal);
  }
  private async executeOwned(
    request: ToolRequest,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (
      !request.id ||
      !request.runId ||
      !request.correlationId ||
      !request.requester ||
      request.id.length > 128 ||
      request.runId.length > 128 ||
      !Number.isFinite(request.deadline) ||
      request.deadline > Date.now() + 120000
    )
      throw new Error("Tool request identity or deadline rejected");
    const digest = hash(canonical(request));
    const grantHash = hash(canonical(this.grant));
    const key = hash(request.runId + ":" + request.id);
    if (!this.grant.permissions.includes(request.operation)) {
      this.store.append(
        request.runId,
        "tool_denied",
        { id: request.id, operation: request.operation },
        request.correlationId,
      );
      throw new Error("Tool operation denied by trusted grant");
    }
    const prior = this.store.get<{
      digest: string;
      grantHash: string;
      result: ToolResult;
    }>("tool-receipts", key);
    if (prior) {
      if (prior.digest !== digest || prior.grantHash !== grantHash)
        throw new Error("Tool request ID reused with different input");
      return prior.result;
    }
    const intention = this.store.get<{
      digest: string;
      grantHash: string;
      path: string;
      sha256: string;
    }>("tool-write-intents", key);
    if (intention) {
      if (intention.digest !== digest || intention.grantHash !== grantHash)
        throw new Error("Tool request ID reused with different input or grant");
      if (!this.grant.permissions.includes("workspace_write"))
        throw new Error("Tool operation denied by trusted grant");
      const target = this.path(intention.path);
      let content: Buffer;
      try {
        const handle = await open(
          target.path,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const before = await handle.stat({ bigint: true });
          this.checkedFile(intention.path, handle, before);
          if (before.size > BigInt(this.maxBytes))
            throw new Error("Workspace read budget exceeded");
          content = await handle.readFile();
          this.checkedFile(
            intention.path,
            handle,
            await handle.stat({ bigint: true }),
          );
        } finally {
          await handle.close();
        }
      } catch {
        throw new Error(
          "Interrupted workspace write requires reconciliation; file is absent",
        );
      }
      if (content.length > this.maxBytes || hash(content) !== intention.sha256)
        throw new Error(
          "Interrupted workspace write requires reconciliation; contents differ",
        );
      const recovered: ToolResult = {
        schemaVersion: 1,
        id: request.id,
        runId: request.runId,
        operation: "workspace_write",
        status: "succeeded",
        artifact: this.store.artifact(content),
        bytes: content.length,
        sha256: intention.sha256,
        source: {
          kind: "workspace",
          location: target.relativePath.replaceAll(sep, "/"),
          retrievedAt: Date.now(),
        },
        content: content.toString("utf8"),
      };
      this.store.transaction(() => {
        this.store.put("tool-receipts", key, {
          digest,
          grantHash,
          result: recovered,
        });
        this.store.append(
          request.runId,
          "tool_reconciled",
          { ...recovered, content: undefined },
          request.correlationId,
        );
      });
      return recovered;
    }
    if (request.deadline <= Date.now())
      throw new Error("Tool request deadline expired before dispatch");
    this.store.append(
      request.runId,
      "tool_requested",
      { id: request.id, operation: request.operation, inputHash: digest },
      request.correlationId,
    );
    const combined = signal
      ? AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(1, request.deadline - Date.now())),
        ])
      : AbortSignal.timeout(Math.max(1, request.deadline - Date.now()));
    try {
      combined.throwIfAborted();
      if (!this.grant.permissions.includes(request.operation))
        throw new Error("Tool operation denied by trusted grant");
      this.store.append(
        request.runId,
        "tool_authorized",
        { id: request.id, grantHash: hash(canonical(this.grant)) },
        request.correlationId,
      );
      let content: Buffer;
      let source: ToolResult["source"];
      if (request.operation === "research_read") {
        const url = new URL(request.args.url ?? "");
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !this.grant.allowedOrigins.includes(url.origin)
        )
          throw new Error(
            "Research URL is outside its grant or contains private query/credentials",
          );
        content = await this.research(url, combined);
        source = { kind: "web", location: url.href, retrievedAt: Date.now() };
      } else if (
        request.operation === "workspace_read" ||
        request.operation === "workspace_write"
      ) {
        const target = this.path(request.args.path);
        if (request.operation === "workspace_read") {
          const handle = await open(
            target.path,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
          );
          try {
            const before = await handle.stat({ bigint: true });
            this.checkedFile(request.args.path, handle, before);
            if (before.size > BigInt(this.maxBytes))
              throw new Error(
                "Workspace file exceeds read budget or is not a regular file",
              );
            this.path(request.args.path);
            content = await handle.readFile({ signal: combined });
            const after = await handle.stat({ bigint: true });
            this.checkedFile(request.args.path, handle, after);
            if (
              before.size !== after.size ||
              before.mtimeNs !== after.mtimeNs ||
              before.ctimeNs !== after.ctimeNs
            )
              throw new Error("Workspace file changed during read");
          } finally {
            await handle.close();
          }
        } else {
          if (typeof request.args.content !== "string")
            throw new Error("Workspace writes require literal UTF-8 content");
          content = Buffer.from(request.args.content);
          if (content.length > this.maxBytes)
            throw new Error("Workspace write exceeds byte budget");
          await mkdir(dirname(target.path), { recursive: true });
          this.path(request.args.path);
          let existing: Buffer | undefined;
          try {
            existing = await readFile(target.path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (
            existing &&
            (!request.args.expectedHash ||
              hash(existing) !== request.args.expectedHash)
          )
            throw new Error(
              "Workspace overwrite requires matching expectedHash",
            );
          if (!existing && request.args.expectedHash)
            throw new Error("Workspace expected file is absent");
          combined.throwIfAborted();
          this.store.put("tool-write-intents", key, {
            digest,
            grantHash,
            path: request.args.path,
            sha256: hash(content),
          });
          this.store.append(
            request.runId,
            "tool_dispatched",
            {
              id: request.id,
              operation: request.operation,
              contentHash: hash(content),
            },
            request.correlationId,
          );
          const temporary = join(dirname(target.path), ".cur-" + randomUUID());
          const handle = await open(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            0o600,
          );
          try {
            await handle.writeFile(content);
            await handle.sync();
          } finally {
            await handle.close();
          }
          try {
            this.path(request.args.path);
            combined.throwIfAborted();
            if (existing) {
              if (
                hash(await readFile(target.path)) !== request.args.expectedHash
              )
                throw new Error("Workspace changed during write");
              await rename(temporary, target.path);
            } else {
              // Exclusive destination prevents a late competing file from being overwritten.
              await link(temporary, target.path);
            }
          } finally {
            await unlink(temporary).catch(() => undefined);
          }
        }
        source = {
          kind: "workspace",
          location: target.relativePath.replaceAll(sep, "/"),
          retrievedAt: Date.now(),
        };
      } else throw new Error("Unknown registered tool operation");
      if (content.length > this.maxBytes)
        throw new Error("Tool result exceeds byte budget");
      const result: ToolResult = {
        schemaVersion: 1,
        id: request.id,
        runId: request.runId,
        operation: request.operation,
        status: "succeeded",
        artifact: this.store.artifact(content),
        bytes: content.length,
        sha256: hash(content),
        source,
        content: content.toString("utf8"),
      };
      this.store.transaction(() => {
        this.store.put("tool-receipts", key, { digest, grantHash, result });
        this.store.append(
          request.runId,
          "tool_completed",
          { ...result, content: undefined },
          request.correlationId,
        );
      });
      return result;
    } catch (error) {
      this.store.append(
        request.runId,
        "tool_failed",
        {
          id: request.id,
          operation: request.operation,
          error: combined.aborted
            ? "Tool cancelled or deadline exceeded"
            : String(error instanceof Error ? error.message : error).slice(
                0,
                300,
              ),
        },
        request.correlationId,
      );
      throw error;
    }
  }
  private async research(url: URL, signal: AbortSignal): Promise<Buffer> {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(lookup(hostname, { all: true }), signal);
    const local = addresses.every(
      (a) => a.address === "127.0.0.1" || a.address === "::1",
    );
    if (
      !addresses.length ||
      (!(local && this.grant.allowLoopbackResearch) &&
        addresses.some((a) => !publicResearchAddress(a.address)))
    )
      throw new Error("Research DNS resolved to a private or reserved address");
    signal.throwIfAborted();
    const address = addresses[0];
    return new Promise<Buffer>((resolveResult, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: "GET",
          signal,
          headers: {
            accept: "text/plain, text/html, application/json",
            "user-agent": "computer-use-runtime/research-read",
          },
          lookup: (_host, options, callback) =>
            options.all
              ? callback(null, [address])
              : callback(null, address.address, address.family),
        },
        (response) => {
          if (
            (response.statusCode ?? 0) >= 300 &&
            (response.statusCode ?? 0) < 400
          ) {
            response.destroy();
            reject(
              new Error(
                "Research redirects require a separate authorized request",
              ),
            );
            return;
          }
          if (
            response.statusCode !== 200 ||
            !/^(?:text\/(?:plain|html|markdown)|application\/json)(?:;|$)/i.test(
              String(response.headers["content-type"]),
            )
          ) {
            response.destroy();
            reject(
              new Error("Research response status or content type rejected"),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > this.maxBytes) {
              response.destroy();
              reject(new Error("Research response exceeds byte budget"));
            } else chunks.push(chunk);
          });
          response.on("end", () => resolveResult(Buffer.concat(chunks)));
          response.on("error", reject);
        },
      );
      request.on("error", reject);
      request.end();
    });
  }
}
