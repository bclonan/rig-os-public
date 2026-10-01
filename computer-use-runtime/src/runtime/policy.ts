import type { Action, Observation, TaskContract } from "../contracts/index.js";
import { validate } from "../contracts/index.js";
import { canonical } from "../util/canonical.js";
export class Policy {
  authorize(task: TaskContract, a: Action, o: Observation) {
    validate("Action", a);
    if (task.unresolved.length) throw new Error("Awaiting consequential input");
    if (!task.effects.includes(a.scope))
      throw new Error("Permission scope denied");
    if (a.requester !== task.requester || a.runId !== task.id)
      throw new Error("Requester/run mismatch");
    if (
      a.host !== task.target.host ||
      a.host !== o.host ||
      a.session !== task.target.session ||
      a.session !== o.session
    )
      throw new Error("Wrong host/session");
    if (a.target !== task.target.identity || a.target !== o.target)
      throw new Error("Target mismatch");
    if (
      task.method?.startsWith("drawing.") &&
      (task.parameters.drawingFrame !== canonical(o.frame) ||
        task.parameters.canvasBounds !== o.facts.canvasBounds)
    )
      throw new Error(
        "The drawing canvas moved or resized after the plan. Create a fresh plan before input.",
      );
    const boundSemantic =
      a.operation === "invoke" ||
      (a.operation === "fill" && o.facts.semanticBackground === true);
    const appNavigation =
      task.method === "desktop.assistant" &&
      task.parameters.desktopScope === "computer" &&
      Boolean(o.desktop) &&
      a.scope === "navigate" &&
      ["switch_window", "launch_app"].includes(a.operation);
    if (
      a.observationId !== o.id ||
      a.revision !== o.revision ||
      Date.now() - o.at > 2000 ||
      (!o.focused && !boundSemantic && !appNavigation)
    )
      throw new Error("Stale observation or focus loss");
    if (JSON.stringify(a.frame) !== JSON.stringify(o.frame))
      throw new Error("Coordinate frame mismatch");
    if (Date.now() > a.deadline) throw new Error("Action deadline expired");
    if (/shell|exec|upload|send|filesystem/.test(a.operation))
      throw new Error("Operation absent from restricted adapter");
  }
}
export class Lease {
  private owner?: string;
  private generation = 0;
  private manual = false;
  private expires = 0;
  constructor(private readonly ttlMs = 30000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 120000)
      throw new Error("Lease duration must be bounded to 120000ms");
  }
  acquire(run: string) {
    if (this.manual) throw new Error("Manual takeover active");
    if (this.owner && this.owner !== run && Date.now() < this.expires)
      throw new Error("Desktop has another input owner");
    this.owner = run;
    this.expires = Date.now() + this.ttlMs;
    return ++this.generation;
  }
  check(a: Action) {
    if (
      this.manual ||
      a.runId !== this.owner ||
      a.generation !== this.generation ||
      Date.now() > this.expires
    )
      throw new Error("Invalid input lease");
    this.expires = Date.now() + this.ttlMs;
  }
  release(run: string) {
    if (this.owner === run) {
      this.owner = undefined;
      this.generation++;
    }
  }
  takeover() {
    this.manual = true;
    this.owner = undefined;
    this.generation++;
  }
  returnControl() {
    this.manual = false;
    this.generation++;
  }
}
