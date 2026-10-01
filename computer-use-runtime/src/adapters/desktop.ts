import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { EnvironmentAdapter } from "../contracts/ports.js";
import type { Action, TaskContract } from "../contracts/index.js";
import type { Store } from "../storage/index.js";
import { BrowserAdapter } from "./browser.js";
import { WindowsAdapter } from "./native.js";
import { UnixAdapter } from "./unix.js";
import { ComputerAdapter, type DesktopWindow } from "./computer.js";
import { desktopApps, launchDesktopApp } from "./desktop-apps.js";
import { arch, release } from "node:os";
import { mkdirSync } from "node:fs";
import { WorkspaceAdapter } from "./workspace.js";
import { createSelectedProvider } from "../providers/selection.js";
import { providerSettings } from "../providers/settings.js";
import type { ModelProvider } from "../contracts/ports.js";
import type { ArtifactConfiguration } from "../service/artifacts.js";
import type { ToolRequest } from "../tools/index.js";
import { canonical, hash } from "../storage/index.js";
export function supportedWindow(w: {
  executable?: string;
  appExecutable?: string;
  title: string;
}) {
  const exe = (w.appExecutable || w.executable)
    ?.split(/[\\/]/)
    .pop()
    ?.toLowerCase();
  return (
    !!exe &&
    ![
      "cmd.exe",
      "powershell.exe",
      "pwsh.exe",
      "windowsterminal.exe",
      "conhost.exe",
      "codex.exe",
      "chatgpt.exe",
      "credentialuibroker.exe",
      "systemsettings.exe",
      "sechealthui.exe",
      "lockapp.exe",
      "keepass.exe",
      "1password.exe",
      "bitwarden.exe",
      "terminal",
      "iterm2",
      "gnome-terminal-server",
      "konsole",
      "xterm",
      "alacritty",
      "kitty",
      "wezterm-gui",
      "foot",
      "tilix",
      "xfce4-terminal",
      "system settings",
      "system preferences",
      "gnome-control-center",
      "systemsettings",
      "polkit-gnome-authentication-agent-1",
      "securityagent",
      "loginwindow",
      "1password",
      "bitwarden",
      "keepassxc",
      "codex",
      "chatgpt",
    ].includes(exe)
  );
}

// Runtime's single execution lane selects an adapter. HTTP readers never rebind it.
export class DesktopRouter implements EnvironmentAdapter {
  readonly browser: BrowserAdapter;
  native?: WindowsAdapter | UnixAdapter;
  computer?: ComputerAdapter;
  unavailable =
    process.platform === "win32"
      ? "Windows desktop support is not installed. Run npm run setup:desktop, then restart."
      : `Desktop support is not ready on ${process.platform}. Run npm run setup:desktop and npm run doctor:desktop.`;
  private active: EnvironmentAdapter;
  private workspaces = new Map<string, WorkspaceAdapter>();
  constructor(
    private store: Store,
    private artifactProvider?: (model: string) => ModelProvider,
  ) {
    this.browser = new BrowserAdapter(store);
    this.active = this.browser;
  }
  configureArtifact(id: string, configuration: ArtifactConfiguration) {
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(id))
      throw new Error("Invalid artifact task identity");
    const prior = this.store.get<ArtifactConfiguration>(
      "artifact-configurations",
      id,
    );
    if (prior && JSON.stringify(prior) !== JSON.stringify(configuration))
      throw new Error("Frozen artifact configuration changed");
    if (!prior) this.store.put("artifact-configurations", id, configuration);
    return this.workspace(id);
  }
  private workspace(id: string) {
    const existing = this.workspaces.get(id);
    if (existing) return existing;
    const configuration = this.store.get<ArtifactConfiguration>(
      "artifact-configurations",
      id,
    );
    if (!configuration)
      throw new Error("Frozen artifact configuration is unavailable");
    const root = resolve(this.store.root, "workspaces", id);
    mkdirSync(root, { recursive: true });
    const allowedOrigins =
      configuration.spec.source.operation === "research_read"
        ? [new URL(configuration.spec.source.location).origin]
        : [];
    const adapter = new WorkspaceAdapter(
      this.store,
      {
        root,
        exclusiveRoot: true,
        allowedOrigins,
        permissions: ["research_read", "workspace_read", "workspace_write"],
        maxBytes: 262144,
      },
      this.artifactProvider
        ? this.artifactProvider(configuration.model)
        : createSelectedProvider(
            providerSettings(configuration).providers,
            configuration.strategy,
          ),
      configuration.spec,
    );
    this.workspaces.set(id, adapter);
    return adapter;
  }
  get host() {
    return this.active.host;
  }
  get session() {
    return this.active.session;
  }
  get identity() {
    return this.active.identity;
  }
  get capabilities() {
    return this.active.capabilities;
  }
  async start(headless = true) {
    await this.browser.start(headless);
    if (
      (process.platform === "win32" &&
        existsSync(resolve("native/target/release/computer-use-native.exe"))) ||
      ["darwin", "linux"].includes(process.platform)
    ) {
      const native =
        process.platform === "win32"
          ? new WindowsAdapter(this.store, false)
          : new UnixAdapter(this.store);
      try {
        await native.start(0);
        this.native = native;
        this.computer = new ComputerAdapter(this.store, native, {
          windows: async () => (await this.windows()).windows,
          apps: desktopApps,
          launch: launchDesktopApp,
          platform: native.platform,
        });
      } catch (e) {
        this.unavailable = String(e);
        await native.close().catch(() => {});
      }
    }
  }
  async windows() {
    const system = {
      platform: process.platform,
      name:
        process.platform === "win32"
          ? "Windows"
          : process.platform === "darwin"
            ? "macOS"
            : process.platform === "linux"
              ? "Linux"
              : process.platform,
      release: release(),
      arch: arch(),
    };
    if (!this.native)
      return {
        available: false,
        reason: this.unavailable,
        system,
        apps: [],
        windows: [] as DesktopWindow[],
      };
    const nativeCapabilities =
      this.native instanceof UnixAdapter
        ? await this.native.refreshCapabilities()
        : undefined;
    const windows: any[] = await this.native.client.call("windows");
    return {
      available: true,
      host: this.native.host,
      session: this.native.session,
      system,
      apps: desktopApps().map(({ id, name }) => ({ id, name })),
      notes: this.native.notes,
      operations: this.native.capabilities,
      consent: nativeCapabilities?.consent,
      backend: nativeCapabilities?.backend,
      windows: windows
        .filter(supportedWindow)
        .slice(0, 500)
        .map((w: any): DesktopWindow => ({
          id: `${w.handle}:${w.pid}`,
          handle: w.handle,
          pid: w.pid,
          title: w.title,
          executable: w.appExecutable || w.executable,
        })),
    };
  }
  async prepare(task: TaskContract) {
    if (task.method?.startsWith("artifact.")) {
      const workspace = this.workspace(task.id);
      const configuration = this.store.get<ArtifactConfiguration>(
        "artifact-configurations",
        task.id,
      )!;
      if (
        configuration.input !== undefined &&
        !this.store.get("artifact-inputs", task.id)
      ) {
        const sourceRequest = this.store.get<ToolRequest>(
          "artifact-source-requests",
          task.id,
        ) ?? {
          id: "uploaded-source",
          runId: task.id,
          correlationId: task.correlationId,
          requester: task.requester,
          operation: "workspace_write",
          args: {
            path: configuration.spec.source.location,
            content: configuration.input,
          },
          deadline: Date.now() + 10000,
        };
        if (!this.store.get("artifact-source-requests", task.id))
          this.store.put("artifact-source-requests", task.id, sourceRequest);
        const result = await workspace.tools.execute(sourceRequest);
        this.store.put("artifact-inputs", task.id, {
          source: result.artifact,
          hash: result.sha256,
        });
      }
      await workspace.prepare(task);
      this.active = workspace;
      return;
    }
    if (
      task.method === "desktop.assistant" ||
      task.method?.startsWith("drawing.")
    ) {
      if (task.method?.startsWith("drawing.")) {
        const plan = this.store.get<{ contractHash: string; ready: boolean }>(
          "drawing-plans",
          task.id,
        );
        if (!plan?.ready || plan.contractHash !== hash(canonical(task)))
          throw new Error(
            "Drawing task does not match its frozen approved plan",
          );
      }
      if (!this.native) throw new Error(this.unavailable);
      if (task.parameters.desktopScope === "computer") {
        await this.computer!.prepare(task);
        this.active = this.computer!;
        return;
      }
      if (
        task.target.host !== this.native.host ||
        task.target.session !== this.native.session
      )
        throw new Error("Desktop host/session mismatch");
      if (
        !(await this.windows()).windows.some(
          (w: any) =>
            String(w.handle) === task.target.identity &&
            w.pid === task.parameters.windowPid,
        )
      )
        throw new Error(
          "Window is unavailable or not supported for desktop control",
        );
      await this.native.setTarget(
        Number(task.target.identity),
        Number(task.parameters.windowPid),
      );
      this.active = this.native;
    } else {
      if (task.target.identity !== this.browser.identity)
        throw new Error("Unknown runtime target");
      this.active = this.browser;
    }
  }
  async focus() {
    await this.active.focus?.();
  }
  observe(signal?: AbortSignal) {
    return this.active.observe(signal);
  }
  acquire(id: string) {
    return this.active.acquire(id);
  }
  execute(action: Action, signal?: AbortSignal) {
    return this.active.execute(action, signal);
  }
  private ownedAdapters(): EnvironmentAdapter[] {
    return [
      ...new Set<EnvironmentAdapter>([
        ...this.workspaces.values(),
        this.browser,
        ...(this.computer ? [this.computer] : this.native ? [this.native] : []),
      ]),
    ];
  }
  private async cleanupOwned(
    operation: (adapter: EnvironmentAdapter) => Promise<void>,
  ) {
    const results = await Promise.allSettled(
      this.ownedAdapters().map((adapter) =>
        Promise.resolve().then(() => operation(adapter)),
      ),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(
        failures,
        "Owned adapter cleanup failed: " + failures.map(String).join("; "),
        { cause: failures[0] },
      );
  }
  release(id: string) {
    return this.cleanupOwned((adapter) => adapter.release(id));
  }
  takeover() {
    return this.cleanupOwned((adapter) => adapter.takeover());
  }
  returnControl() {
    return this.cleanupOwned((adapter) => adapter.returnControl());
  }
  cleanupScopes() {
    return this.ownedAdapters().map((adapter) => ({
      host: adapter.host,
      session: adapter.session,
    }));
  }
  reset(...args: Parameters<BrowserAdapter["reset"]>) {
    return this.browser.reset(...args);
  }
  close() {
    return this.cleanupOwned((adapter) => adapter.close());
  }
}
