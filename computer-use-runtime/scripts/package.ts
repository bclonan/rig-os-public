import { spawnSync } from "node:child_process";
const result = spawnSync(
  process.platform === "win32" ? "python" : "python3",
  ["scripts/package.py"],
  { stdio: "inherit", windowsHide: true },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
