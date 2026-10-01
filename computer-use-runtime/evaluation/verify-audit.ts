import { verifySealedAudit } from "../src/learner/audit.js";
const { report: _report, ...result } = verifySealedAudit();
console.log(JSON.stringify(result, null, 2));
