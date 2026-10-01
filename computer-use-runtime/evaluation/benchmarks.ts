import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
const contract = spawnSync("python", ["evaluation/benchmark_contract.py"], {
  encoding: "utf8",
  windowsHide: true,
});
const upstream = JSON.parse(
  readFileSync("evidence/upstream/index.json", "utf8"),
);
const docker = spawnSync("docker", ["ps", "--format", "{{.Names}}"], {
  encoding: "utf8",
  windowsHide: true,
  timeout: 15000,
});
const result = {
  contract:
    contract.status === 0
      ? JSON.parse(contract.stdout)
      : { status: "FAIL", error: contract.stderr },
  OSWorld: {
    status: "BLOCKED",
    reason:
      "No configured OSWorld VM, task snapshot or benchmark reset endpoint",
    commit: upstream.find((r: any) => r.repository === "xlang-ai/OSWorld")
      ?.commit,
  },
  WindowsAgentArena: {
    status: "BLOCKED",
    reason: "No configured WindowsAgentArena VM image or benchmark task runner",
    commit: upstream.find(
      (r: any) => r.repository === "microsoft/WindowsAgentArena",
    )?.commit,
  },
  LinuxVM: {
    status: "BLOCKED",
    reason: "No authorized interactive Linux VM configured",
  },
  secondMachine: {
    status: "BLOCKED",
    reason:
      "No second-machine identity and authorized runtime endpoint configured",
  },
  telegram: {
    status: "BLOCKED",
    reason:
      "No task-specific bot credential and authorized chat configured; credentials were not inspected",
  },
  dockerAvailable: docker.status === 0,
};
writeFileSync("evidence/benchmarks.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
