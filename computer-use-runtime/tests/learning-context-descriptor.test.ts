import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { seedForm, seal, Registry } from "../src/skills/index.js";
import {
  programDescriptor,
  programClosure,
} from "../src/learner/descriptor.js";
import {
  repairSkills,
  repairComposition,
  qualifiedProgramForecast,
} from "../src/learner/selector.js";
import { browserProgramBank } from "../evaluation/learning-followup-v4-bank.js";
import { canonical, hash, Store } from "../src/storage/index.js";
import { ModelRegistry } from "../src/learner/index.js";
import type { FollowupQualification } from "../src/learner/qualification.js";

test("program bank registers dependencies before composition roots", () => {
  const bank = browserProgramBank(),
    store = new Store(mkdtempSync(join(tmpdir(), "cur-program-bank-")));
  try {
    const registry = new Registry(store);
    for (const skill of bank.all) registry.put(skill);
    for (const program of bank.programs) {
      assert.equal(registry.get(program.id).hash, program.hash);
      assert.deepEqual(
        programClosure(program, (id) => registry.get(id)),
        programClosure(program, bank.lookup),
      );
    }
  } finally {
    store.close();
  }
});

test("program features distinguish a repair composition from its bare repair", () => {
  const form = seedForm(),
    [open] = repairSkills(),
    all = [form, open];
  const lookup = (id: string) => all.find((skill) => skill.id === id)!;
  const plan = repairComposition(form, [open, form], open.descriptor);
  assert.notDeepEqual(
    programDescriptor(open, lookup),
    programDescriptor(plan, lookup),
  );
  const bank = browserProgramBank();
  assert.equal(
    new Set(
      bank.descriptors.map((candidate) => canonical(candidate.descriptor)),
    ).size,
    bank.programs.length,
  );
});

test("guards, verification, waits, recovery, budgets and literal effect text change features", () => {
  const original = seedForm(),
    describe = (skill: typeof original) =>
      programDescriptor(skill, () => {
        throw new Error("Unexpected dependency");
      });
  for (const mutation of [
    (skill: typeof original) => {
      skill.machine.states[0].steps[0].guard = "closed";
    },
    (skill: typeof original) => {
      skill.machine.states[0].steps[0].verify = "dialog";
    },
    (skill: typeof original) => {
      skill.machine.states[0].steps[0].waitMs = 42;
    },
    (skill: typeof original) => {
      skill.recovery = ["different_recovery"];
    },
    (skill: typeof original) => {
      skill.budgets.steps += 1;
    },
    (skill: typeof original) => {
      skill.machine.states[0].steps[0].args.value = "literal first";
    },
    (skill: typeof original) => {
      skill.machine.states[0].steps[0].args.value = "literal second";
    },
  ]) {
    const changed = structuredClone(original);
    mutation(changed);
    assert.notDeepEqual(describe(original), describe(seal(changed)));
  }
  const first = structuredClone(original),
    second = structuredClone(original);
  first.machine.states[0].steps[0].args.value = "first";
  second.machine.states[0].steps[0].args.value = "second";
  assert.notDeepEqual(describe(seal(first)), describe(seal(second)));
  const renamed = structuredClone(original);
  renamed.id = "random-parent";
  renamed.machine.initial = "random-state";
  renamed.machine.states[0].id = "random-state";
  renamed.machine.states[0].steps[0].id = "random-step";
  assert.deepEqual(describe(original), describe(seal(renamed)));
});

test("only matching descriptor version and tested immutable template can expose a forecast", () => {
  const skill = seedForm(),
    template = hash(canonical({ ...skill, hash: "", compatibility: [] }));
  const qualification = {
    candidateDescriptorVersion: 2,
    skillTemplates: [template],
    programBindings: [
      {
        template,
        closure: programClosure(skill, () => {
          throw new Error("Unexpected child");
        }),
      },
    ],
  } as FollowupQualification;
  assert.equal(
    qualifiedProgramForecast(qualification, 2, skill, () => {
      throw new Error("Unexpected child");
    }),
    true,
  );
  assert.equal(qualifiedProgramForecast(qualification, 1, skill), false);
  assert.equal(qualifiedProgramForecast(undefined, 2, skill), false);
  const untested = seal({ ...skill, version: "2.0.0" });
  assert.equal(qualifiedProgramForecast(qualification, 2, untested), false);
  const changed = structuredClone(skill);
  changed.machine.states[0].steps[0].args.value = "different literal";
  assert.equal(
    qualifiedProgramForecast(qualification, 2, seal(changed)),
    false,
  );
});

test("root identity cannot qualify a changed or missing dependency", () => {
  const form = seedForm(),
    [open] = repairSkills();
  const plan = repairComposition(form, [open, form], open.descriptor);
  const original = (id: string) =>
    [form, open].find((skill) => skill.id === id)!;
  const template = hash(canonical({ ...plan, hash: "", compatibility: [] }));
  const qualification = {
    candidateDescriptorVersion: 2,
    skillTemplates: [template],
    programBindings: [{ template, closure: programClosure(plan, original) }],
  } as FollowupQualification;
  assert.equal(
    qualifiedProgramForecast(qualification, 2, plan, original),
    true,
  );
  const changed = structuredClone(open);
  changed.machine.states[0].steps[0].waitMs = 100;
  const altered = seal(changed);
  assert.equal(
    qualifiedProgramForecast(qualification, 2, plan, (id) =>
      id === open.id ? altered : original(id),
    ),
    false,
  );
  assert.equal(
    qualifiedProgramForecast(qualification, 2, plan, () => {
      throw new Error("Missing child");
    }),
    false,
  );
  assert.equal(qualifiedProgramForecast(qualification, 2, plan), false);
});

test("registration metadata preserves descriptor version without granting qualification", () => {
  const directory = mkdtempSync(join(tmpdir(), "cur-descriptor-model-"));
  // This exercises untrusted metadata only. It never forwards or qualifies these original bundled bytes as a V4 model.
  const model = readFileSync("models/17/trained.onnx"),
    report = {
      seed: 17,
      parameters: 10041,
      onnxMaxError: 0,
      contextVersion: 4,
      sha256: hash(model),
      evidenceScope:
        "Registration metadata fixture, no forward or V4 qualification",
    };
  const path = join(directory, "trained.onnx");
  writeFileSync(path, model);
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify({ ...report, candidateDescriptorVersion: 2 }),
  );
  const store = new Store(join(directory, "store"));
  try {
    const registry = new ModelRegistry(store),
      candidate = registry.register("scoped-descriptor", path, 17);
    assert.equal(candidate.metrics.candidateDescriptorVersion, 2);
    assert.throws(
      () => registry.activate(candidate.id),
      /trusted scoped followup qualification/,
    );
    writeFileSync(
      join(directory, "report.json"),
      JSON.stringify({ ...report, candidateDescriptorVersion: 3 }),
    );
    assert.throws(
      () => registry.register("unsupported", path, 17),
      /report does not match/,
    );
  } finally {
    store.close();
  }
});
