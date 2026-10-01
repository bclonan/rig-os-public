import { readFileSync } from "node:fs";
import { hash } from "../storage/index.js";

export function verifySealedAudit() {
  const seal = JSON.parse(readFileSync("evidence/audit-sealed.json", "utf8"));
  const report = JSON.parse(readFileSync("evidence/results.json", "utf8"));
  if (
    hash(JSON.stringify(report)) !== seal.resultsHash ||
    hash(readFileSync("evidence/episodes.jsonl")) !== seal.episodesHash ||
    hash(readFileSync("acceptance.json")) !== seal.protocolHash
  )
    throw new Error("Audit integrity gate rejected");
  return {
    status: "PASS",
    kind: "sealed-audit-integrity",
    protocolHash: seal.protocolHash,
    resultsHash: seal.resultsHash,
    episodesHash: seal.episodesHash,
    note: "These checks verify the saved audit bytes. They do not rerun episodes or change failed acceptance gates.",
    report,
  };
}
