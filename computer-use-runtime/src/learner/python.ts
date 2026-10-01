import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function trainingPython() {
  const path = resolve(
    process.platform === "win32"
      ? ".venv/Scripts/python.exe"
      : ".venv/bin/python",
  );
  return (
    process.env.CUR_TRAINING_PYTHON ||
    (existsSync(path)
      ? path
      : process.platform === "win32"
        ? "python"
        : "python3")
  );
}
