import { Store } from "../src/storage/index.js";
import { Recorder, type Demonstration } from "../src/recorder/index.js";
import { exportDataset } from "../src/recorder/bundle.js";
import { writeFileSync } from "node:fs";
const store = new Store(".data/command-check");
try {
  const demo = store
    .list<Demonstration>("demonstrations")
    .find((d) => d.verified);
  if (!demo) throw new Error("Record the command-check demonstrations first");
  const correction = new Recorder(store).correct(
    demo.id,
    0,
    "unknown",
    "controlled negative-label test; not a claim that the successful action failed",
  );
  if (correction.verified)
    throw new Error("Correction did not revoke positive label");
  writeFileSync(
    "evidence/corrected-dataset-bundle.json",
    JSON.stringify(exportDataset(store)),
  );
  console.log(
    JSON.stringify({
      status: "PASS",
      demonstration: demo.id,
      label: correction.steps[0].label,
      verified: correction.verified,
      source: "controlled correction injection on an actually reached state",
    }),
  );
} finally {
  store.close();
}
