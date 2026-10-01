import { randomUUID } from "node:crypto";
import type {
  Action,
  Observation,
  Receipt,
  TaskContract,
} from "../contracts/index.js";
import type { Store } from "../storage/index.js";
export type Demonstration = {
  id: string;
  session: string;
  contract: TaskContract;
  steps: {
    before: Observation;
    action: Action;
    receipt: Receipt;
    after: Observation;
    guard?: string;
    verify?: string;
    label: "verified" | "failure" | "unknown";
  }[];
  verified: boolean;
  corrections: { step: number; label: string; source: string }[];
};
export class Recorder {
  constructor(readonly store: Store) {}
  capture(runId: string): Demonstration {
    const run = this.store.run(runId);
    const events = this.store.events(0, runId);
    const verified = run.status === "succeeded";
    const demo: Demonstration = {
      id: randomUUID(),
      session: runId,
      contract: run.contract,
      steps: events
        .filter((e) => e.type === "experience")
        .map((e) => ({
          ...(e.data as any),
          label: ["failure", "unknown"].includes((e.data as any).label)
            ? (e.data as any).label
            : verified
              ? "verified"
              : "unknown",
        })),
      verified,
      corrections: [],
    };
    demo.verified =
      verified && demo.steps.every((step) => step.label === "verified");
    if (!demo.steps.length)
      throw new Error(
        "This run has no recorded before/action/after experience",
      );
    if (demo.steps.some((s) => !s.before.image || !s.after.image))
      throw new Error("Demonstration requires before/after image references");
    this.store.put("demonstrations", demo.id, demo);
    return demo;
  }
  correct(id: string, step: number, label: string, source: string) {
    if (!["failure", "unknown"].includes(label))
      throw new Error(
        "Corrections can reject or mark unknown; positive labels require independent execution evidence",
      );
    const d = this.store.get<Demonstration>("demonstrations", id);
    if (!d || !d.steps[step]) throw new Error("Missing demonstrated step");
    d.corrections.push({ step, label, source });
    d.verified = false;
    d.steps[step].label = label as "failure" | "unknown";
    this.store.put("demonstrations", id, d);
    return d;
  }
  export() {
    return {
      schemaVersion: 1,
      kind: "recorded-experience",
      demonstrations: this.store.list<Demonstration>("demonstrations"),
    };
  }
}
