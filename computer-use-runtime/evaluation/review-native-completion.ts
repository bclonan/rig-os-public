import {
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { Store } from "../src/storage/index.js";
const paint = JSON.parse(readFileSync("evidence/paint-save.json", "utf8"));
const bytes = readFileSync(paint.path);
const png = bytes
  .subarray(0, 8)
  .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
let correctedStore = false;
if (!png) {
  for (const directory of readdirSync(".data").filter((n) =>
    n.startsWith("paint-save-"),
  )) {
    const store = new Store(".data/" + directory);
    try {
      const run = store.runs().find((r) => r.id === paint.run.id);
      if (run) {
        run.status = "blocked";
        run.error =
          "Independent artifact inspection rejected the earlier file-existence completion. Saved bytes were not PNG.";
        store.putRun(run);
        store.append(
          run.id,
          "completion_rejected",
          { previousStatus: "succeeded", reason: run.error },
          run.contract.correlationId,
        );
        correctedStore = true;
      }
    } finally {
      store.close();
    }
  }
}
writeFileSync(
  "evidence/native-completion-review.json",
  JSON.stringify(
    {
      status: png ? "PASS" : "FAIL",
      scope: "native Paint shape and PNG task",
      initialVerifier:
        "file existence only, insufficient for the requested format",
      nativeFalseCompletionCount: png ? 0 : 1,
      runId: paint.run.id,
      pngSignature: png,
      correctedStore,
      initialEvidencePreserved: "evidence/paint-save.json",
      browserAuditFalseSuccess: 0,
    },
    null,
    2,
  ),
);
const dog = JSON.parse(readFileSync("evidence/paint.json", "utf8"));
if (dog.status === "PARTIAL") {
  copyFileSync("evidence/paint.json", "evidence/paint-original-dispatch.json");
  dog.status = "FAIL";
  dog.operationalDispatch =
    dog.completedSegments === dog.totalSegments ? "PASS" : "FAIL";
  dog.reason = "Separate semantic assessment did not recognize a dog";
  writeFileSync("evidence/paint.json", JSON.stringify(dog, null, 2));
}
