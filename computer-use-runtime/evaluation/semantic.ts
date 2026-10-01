import { readFileSync, writeFileSync } from "node:fs";
import { LocalVisionAssessor } from "../src/providers/vision.js";
const cases = JSON.parse(readFileSync("evidence/semantic/cases.json", "utf8"));
const assessor = new LocalVisionAssessor("qwen3.5:0.8b");
const outcomes = [];
for (const c of cases) {
  try {
    const result = await assessor.assess("dog", readFileSync(c.image));
    outcomes.push({
      ...c,
      ...result,
      passed:
        c.expectedRecognizable === null
          ? null
          : result.assessment.recognizable === c.expectedRecognizable,
    });
  } catch (e) {
    outcomes.push({ ...c, status: "FAIL", reason: String(e), passed: false });
  }
  writeFileSync(
    "evidence/semantic/results.json",
    JSON.stringify(
      {
        status: outcomes
          .filter((c) => c.expectedRecognizable === false)
          .every((c) => c.passed)
          ? "PASS"
          : "FAIL",
        evidenceLevel:
          "local independent-model assessment and controlled negatives",
        objectiveDogSuccess: false,
        outcomes,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(outcomes.at(-1)));
}
