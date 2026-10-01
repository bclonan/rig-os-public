import type { SkillCapsule, Observation } from "../src/contracts/index.js";
import { seedForm, seal } from "../src/skills/index.js";
import { repairComposition, repairSkills } from "../src/learner/selector.js";
import { programDescriptor } from "../src/learner/descriptor.js";

export function browserProgramBank() {
  const form = seedForm(),
    [open, dismiss] = repairSkills();
  // These standalone fixtures declare the public fields their programs can reach.
  const localOpen = seal({ ...open, id: "fixture.open", outputs: ["ready"] });
  const localDismiss = seal({
    ...dismiss,
    id: "fixture.dismiss",
    outputs: ["dialog"],
  });
  const programs = [
    form,
    localOpen,
    localDismiss,
    repairComposition(form, [open, form], open.descriptor),
    repairComposition(form, [dismiss, form], dismiss.descriptor),
    repairComposition(form, [dismiss, open, form], dismiss.descriptor),
    seal({
      ...form,
      id: "fixture.insufficient.fill",
      machine: {
        initial: "fill",
        states: [
          {
            id: "fill",
            steps: [
              {
                id: "fill",
                operation: "fill",
                args: { locator: "name", value: "$name" },
                scope: "edit",
              },
            ],
            monitor: ["focused"],
          },
        ],
      },
    }),
    seal({
      ...form,
      id: "fixture.insufficient.open",
      preconditions: [],
      capabilities: ["click"],
      descriptor: open.descriptor,
      machine: {
        initial: "open",
        states: [
          {
            id: "open",
            steps: [
              {
                id: "open",
                operation: "click",
                args: { locator: "open" },
                scope: "edit",
              },
            ],
            monitor: ["focused"],
          },
        ],
      },
    }),
  ];
  const all = [open, dismiss, ...programs];
  const lookup = (id: string): SkillCapsule => {
    const skill = all.find((candidate) => candidate.id === id);
    if (!skill) throw new Error("Missing fixture child");
    return skill;
  };
  return {
    programs,
    all,
    lookup,
    descriptors: programs.map((program) => ({
      descriptor: programDescriptor(program, lookup),
    })),
    abstention: { descriptor: [0, 0, 0, 1, 0, 0, 0, 0] },
  };
}
export function completeFormProgram(before: Observation) {
  return before.facts.dialog === true
    ? before.facts.closed === true
      ? 5
      : 4
    : before.facts.closed === true
      ? 3
      : 0;
}
