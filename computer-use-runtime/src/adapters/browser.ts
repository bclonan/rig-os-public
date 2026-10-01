import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type Page } from "playwright";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  validate,
  type Action,
  type Observation,
  type Receipt,
} from "../contracts/index.js";
import type { ArtifactStore, EnvironmentAdapter } from "../contracts/ports.js";
import { Lease } from "../runtime/policy.js";
import { hash } from "../util/canonical.js";
export class BrowserAdapter implements EnvironmentAdapter {
  readonly host = hostname();
  readonly session: string;
  readonly identity: string;
  readonly capabilities = [
    "fill",
    "click",
    "key",
    "scroll",
    "drag",
    "hold",
    "observe",
  ];
  browser!: Browser;
  page!: Page;
  private lease = new Lease();
  private last?: Observation;
  private held = new Set<string>();
  private mouseHeld = false;
  private async keyDown(key: string) {
    this.held.add(key);
    try {
      await this.page.keyboard.down(key);
    } catch (error) {
      // Playwright rejects unknown keys before sending input. Other transport
      // errors can follow delivery, so retain attempted input for cleanup.
      if (String(error).includes(`Unknown key: "${key}"`))
        this.held.delete(key);
      throw error;
    }
  }
  private async releaseHeldInput(
    keys = [...this.held].reverse(),
    mouse = this.mouseHeld,
  ) {
    const errors: unknown[] = [];
    for (const key of keys) {
      if (!this.held.has(key)) continue;
      try {
        await this.page.keyboard.up(key);
        this.held.delete(key);
      } catch (error) {
        errors.push(error);
      }
    }
    if (mouse && this.mouseHeld) {
      try {
        await this.page.mouse.up();
        this.mouseHeld = false;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      this.lease.takeover();
      throw new AggregateError(
        errors,
        "Browser input cleanup failed. " + String(errors[0]),
      );
    }
  }
  private async dispatchWithCleanup(
    dispatch: () => Promise<void>,
    keys: string[],
    mouse: boolean,
  ) {
    let dispatchError: unknown;
    try {
      await dispatch();
    } catch (error) {
      dispatchError = error;
    }
    try {
      await this.releaseHeldInput(keys, mouse);
    } catch (cleanupError) {
      if (dispatchError)
        throw new AggregateError(
          [dispatchError, cleanupError],
          "Browser dispatch and cleanup failed. " +
            String(dispatchError) +
            "; " +
            String(cleanupError),
          { cause: dispatchError },
        );
      throw cleanupError;
    }
    if (dispatchError) throw dispatchError;
  }
  constructor(
    private store: Pick<ArtifactStore, "artifact">,
    session = "browser-local",
    identity = "browser-fixture-v1",
  ) {
    this.session = session;
    this.identity = identity;
  }
  async start(headless = true) {
    this.browser = await chromium.launch({ headless });
    this.page = await this.browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    await this.page.route("**/*", (route) => {
      const u = route.request().url();
      return u.startsWith("file:") || u.startsWith("data:")
        ? route.continue()
        : route.abort();
    });
    await this.reset();
    return this;
  }
  async reset(mode = "ready", layout = "base") {
    await this.page.goto(
      pathToFileURL(resolve("fixtures/workbench.html")).href +
        `?mode=${mode}&layout=${layout}`,
    );
    this.last = undefined;
  }
  private async state() {
    return this.page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>("#name");
      const result = document.querySelector("#result");
      const notice = document.querySelector<HTMLDialogElement>("#notice");
      const editor = document.querySelector<HTMLElement>("#editor");
      const canvas = document.querySelector<HTMLCanvasElement>("#indicator");
      const pixel = canvas?.getContext("2d")?.getImageData(8, 8, 1, 1).data;
      const publicFacts = Object.fromEntries(
        Array.from(document.querySelectorAll<HTMLElement>("[data-fact]")).map(
          (el) => [el.dataset.fact!, el.textContent || ""],
        ),
      );
      return {
        facts: {
          docsOpen:
            !!document.querySelector<HTMLDetailsElement>("details")?.open,
          ready: !!editor && !editor.hidden && !notice?.open,
          dialog: !!notice?.open,
          closed: !!editor?.hidden,
          name: input?.value || "",
          result: result?.textContent || "",
          focused: true,
          ...publicFacts,
        },
        features: pixel
          ? [pixel[0] / 255, pixel[1] / 255, pixel[2] / 255]
          : [0, 0, 0],
        width: innerWidth,
        height: innerHeight,
        scale: devicePixelRatio,
        identity: location.href,
        layout: editor?.getBoundingClientRect().toJSON(),
      };
    });
  }
  async observe(signal?: AbortSignal): Promise<Observation> {
    signal?.throwIfAborted();
    const state = await this.state();
    const image = this.store.artifact(
      await this.page.screenshot({ type: "png" }),
    );
    this.last = {
      schemaVersion: 1,
      id: randomUUID(),
      host: this.host,
      session: this.session,
      target: this.identity,
      at: Date.now(),
      revision: hash(JSON.stringify(state)),
      frame: {
        x: 0,
        y: 0,
        width: state.width,
        height: state.height,
        scale: state.scale,
      },
      focused: true,
      facts: state.facts,
      image,
      features: state.features,
      backend: "playwright",
    };
    return this.last;
  }
  async acquire(runId: string) {
    return this.lease.acquire(runId);
  }
  async execute(a: Action, signal?: AbortSignal): Promise<Receipt> {
    validate("Action", a);
    this.lease.check(a);
    signal?.throwIfAborted();
    if (
      a.host !== this.host ||
      a.session !== this.session ||
      a.target !== this.identity
    )
      throw new Error("Wrong host/session/target at adapter boundary");
    if (
      !this.last ||
      a.observationId !== this.last.id ||
      Date.now() - this.last.at > 2000 ||
      a.revision !== hash(JSON.stringify(await this.state()))
    )
      throw new Error("Stale adapter observation");
    if (JSON.stringify(a.frame) !== JSON.stringify(this.last.frame))
      throw new Error("Changed adapter coordinate frame");
    if (a.deadline < Date.now()) throw new Error("Expired at host boundary");
    if (!this.capabilities.includes(a.operation))
      throw new Error("Unsupported browser operation");
    const t = performance.now();
    const selector = String(a.args.locator || "");
    if (selector && !/^[a-zA-Z0-9_-]{1,80}$/.test(selector))
      throw new Error("Invalid structured locator");
    const loc = this.page.locator(`[data-control="${selector}"]`);
    const timeout = Math.max(1, Math.min(2000, a.deadline - Date.now()));
    switch (a.operation) {
      case "fill":
        await loc.fill(String(a.args.value), { timeout });
        break;
      case "click":
        this.mouseHeld = true;
        await this.dispatchWithCleanup(
          async () => {
            await loc.click({ timeout });
            this.mouseHeld = false;
          },
          [],
          true,
        );
        break;
      case "key": {
        const keys: string[] = [];
        let token = "";
        for (const character of String(a.args.key)) {
          if (character === "+" && token) {
            keys.push(token);
            token = "";
          } else token += character;
        }
        keys.push(token);
        await this.dispatchWithCleanup(
          async () => {
            for (const key of keys) await this.keyDown(key);
          },
          keys.slice().reverse(),
          false,
        );
        break;
      }
      case "scroll":
        await this.page.mouse.wheel(
          Number(a.args.x || 0),
          Number(a.args.y || 0),
        );
        break;
      case "hold": {
        const key = String(a.args.key);
        await this.dispatchWithCleanup(
          async () => {
            await this.keyDown(key);
            await delay(
              Math.min(Number(a.args.ms || 50), 1000, timeout),
              undefined,
              { signal },
            );
          },
          [key],
          false,
        );
        break;
      }
      case "drag": {
        const x = Number(a.args.x),
          y = Number(a.args.y),
          dx = Number(a.args.dx),
          dy = Number(a.args.dy);
        if ([x, y, dx, dy].some((v) => !Number.isFinite(v)))
          throw new Error("Invalid drag");
        await this.page.mouse.move(x, y);
        this.mouseHeld = true;
        await this.dispatchWithCleanup(
          async () => {
            await this.page.mouse.down();
            await this.page.mouse.move(dx, dy, { steps: 8 });
          },
          [],
          true,
        );
        break;
      }
      case "observe":
        break;
    }
    return {
      schemaVersion: 1,
      actionId: a.id,
      runId: a.runId,
      backend: "playwright",
      at: Date.now(),
      phase: "acknowledged",
      detail:
        "Browser operation acknowledged; effect requires a separate observation",
      timings: { dispatchMs: performance.now() - t },
    };
  }
  async release(run: string) {
    await this.releaseHeldInput();
    this.lease.release(run);
  }
  async takeover() {
    this.lease.takeover();
    await this.releaseHeldInput();
  }
  async returnControl() {
    await this.releaseHeldInput();
    this.lease.returnControl();
  }
  async close() {
    await this.browser?.close();
  }
}
