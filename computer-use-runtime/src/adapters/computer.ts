import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { EnvironmentAdapter } from "../contracts/ports.js";
import type {
  Action,
  Observation,
  Receipt,
  TaskContract,
} from "../contracts/index.js";
import { canonical, hash, type Store } from "../storage/index.js";
import { Lease, Policy } from "../runtime/policy.js";

export type DesktopWindow = NonNullable<
  Observation["desktop"]
>["windows"][number];
export type LaunchableApp = { id: string; name: string; executables: string[] };
type NativeDesktop = EnvironmentAdapter & {
  setTarget(handle: number, pid: number): Promise<void>;
};
export class ComputerAdapter implements EnvironmentAdapter {
  get capabilities() {
    return [...this.native.capabilities, "switch_window", "launch_app"];
  }
  private task?: TaskContract;
  private window?: DesktopWindow;
  private last?: Observation;
  private lease = new Lease();
  private nativeGeneration = 0;
  constructor(
    private store: Store,
    private native: NativeDesktop,
    private catalog: {
      windows(): Promise<DesktopWindow[]>;
      apps(): LaunchableApp[];
      launch(id: string): Promise<void>;
      platform?: string;
    },
  ) {}
  get host() {
    return this.native.host;
  }
  get session() {
    return this.native.session;
  }
  get identity() {
    return `computer:${this.session}`;
  }
  async prepare(task: TaskContract) {
    if (
      task.method !== "desktop.assistant" ||
      task.parameters.desktopScope !== "computer" ||
      task.target.identity !== this.identity ||
      task.target.host !== this.host ||
      task.target.session !== this.session
    )
      throw new Error("Computer task host/session/scope mismatch");
    this.task = task;
    this.last = undefined;
    const id = this.store.run(task.id).bindings.activeWindow;
    this.window = (await this.catalog.windows()).find((w) => w.id === id);
    if (this.window)
      await this.native.setTarget(this.window.handle, this.window.pid);
    else if (id) this.rememberWindow();
  }
  private async currentWindows() {
    const windows = await this.catalog.windows();
    if (
      this.window &&
      !windows.some(
        (w) =>
          w.id === this.window!.id && w.executable === this.window!.executable,
      )
    ) {
      this.window = undefined;
      this.rememberWindow();
    }
    return windows;
  }
  private rememberWindow() {
    if (!this.task) throw new Error("No computer task selected");
    const run = this.store.run(this.task.id);
    if (this.window) run.bindings.activeWindow = this.window.id;
    else delete run.bindings.activeWindow;
    this.store.putRun(run);
  }
  async focus() {
    await this.currentWindows();
    if (this.window) await this.native.focus?.();
  }
  async observe(signal?: AbortSignal): Promise<Observation> {
    signal?.throwIfAborted();
    const windows = await this.currentWindows();
    const desktop = {
      platform: this.catalog.platform || "Windows",
      activeWindow: this.window?.id,
      windows,
      apps: this.catalog.apps().map(({ id, name }) => ({ id, name })),
    };
    const o: Observation = this.window
      ? await this.native.observe(signal)
      : {
          schemaVersion: 1,
          id: randomUUID(),
          host: this.host,
          session: this.session,
          target: this.identity,
          at: Date.now(),
          revision: hash(canonical(desktop)),
          frame: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
          focused: true,
          facts: { windowTitle: "This computer", windowHandle: 0 },
          controls: [],
          features: [],
          backend: "desktop-app-catalog",
        };
    this.last = { ...o, target: this.identity, desktop };
    return this.last;
  }
  async acquire(runId: string) {
    const generation = this.lease.acquire(runId);
    try {
      this.nativeGeneration = await this.native.acquire(runId);
    } catch (e) {
      this.lease.release(runId);
      throw e;
    }
    return generation;
  }
  async execute(action: Action, signal?: AbortSignal): Promise<Receipt> {
    signal?.throwIfAborted();
    this.lease.check(action);
    if (!this.task || !this.last)
      throw new Error("Observe the computer before acting");
    new Policy().authorize(this.task, action, this.last);
    const windows = await this.currentWindows();
    if (
      action.operation === "switch_window" ||
      action.operation === "launch_app"
    ) {
      if (action.scope !== "navigate")
        throw new Error("App navigation permission required");
      let target: DesktopWindow | undefined;
      if (action.operation === "switch_window") {
        const proposed = this.last.desktop!.windows.find(
          (w) => w.id === action.args.window,
        );
        target = windows.find(
          (w) =>
            w.id === proposed?.id &&
            w.executable === proposed.executable &&
            w.title === proposed.title,
        );
        if (!target) throw new Error("The proposed window closed or changed");
      } else {
        const app = this.catalog.apps().find((a) => a.id === action.args.app);
        if (!app || !this.last.desktop!.apps.some((a) => a.id === app.id))
          throw new Error("Unknown launcher app");
        signal?.throwIfAborted();
        await this.catalog.launch(app.id);
        // A launch can reuse a window. Bind only a unique new/changed window or
        // the sole matching app window. Ambiguity returns to the app picker.
        const until = Math.min(action.deadline, Date.now() + 8000);
        do {
          await delay(300, undefined, { signal });
          const matches = (await this.catalog.windows()).filter((w) =>
            app.executables.includes(
              w.executable.split(/[\\/]/).pop()!.toLowerCase(),
            ),
          );
          const changed = matches.filter(
            (w) =>
              !windows.some(
                (before) => before.id === w.id && before.title === w.title,
              ),
          );
          target =
            changed.length === 1
              ? changed[0]
              : matches.length === 1
                ? matches[0]
                : undefined;
        } while (!target && Date.now() < until);
      }
      signal?.throwIfAborted();
      if (Date.now() > action.deadline)
        throw new Error("App navigation deadline expired");
      this.window = target;
      this.rememberWindow();
      if (target) {
        await this.native.setTarget(target.handle, target.pid);
        await this.native.focus?.();
      }
      this.last = undefined;
      return {
        schemaVersion: 1,
        actionId: action.id,
        runId: action.runId,
        at: Date.now(),
        phase: "acknowledged",
        backend: "desktop-app-navigation",
        timings: {},
        detail: target
          ? `Selected ${target.title}`
          : "App launch requested. Select its window from the fresh app list.",
      };
    }
    if (!this.window || this.last.desktop?.activeWindow !== this.window.id)
      throw new Error("The reviewed window is no longer available");
    signal?.throwIfAborted();
    return this.native.execute(
      {
        ...action,
        target: this.native.identity,
        generation: this.nativeGeneration,
      },
      signal,
    );
  }
  async release(id: string) {
    await this.native.release(id);
    this.lease.release(id);
  }
  async takeover() {
    this.lease.takeover();
    await this.native.takeover();
  }
  async returnControl() {
    await this.native.returnControl();
    this.lease.returnControl();
  }
  async close() {
    await this.native.close();
  }
}
