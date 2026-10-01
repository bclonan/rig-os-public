import { resolve } from "node:path";
import {
  installQualifiedFollowup,
  prepareFollowupRequalification,
} from "../src/learner/requalification.js";

const [command, directory, argument, seed] = process.argv.slice(2);
if (process.argv.length > 6 || (command !== "activate" && seed !== undefined))
  throw new Error("Unexpected requalification arguments");
if (!directory)
  throw new Error(
    "Use prepare <fresh-parent/learning-followup-v4> [source-root], install <qualified-root> <stopped-data-directory>, or activate <qualified-root> <stopped-data-directory> [seed]",
  );
if (command === "prepare") {
  console.log(
    JSON.stringify(
      prepareFollowupRequalification(
        resolve(argument || "evidence/learning-followup-v4"),
        resolve(directory),
      ),
      null,
      2,
    ),
  );
} else if (command === "install" || command === "activate") {
  if (!argument)
    throw new Error("Choose the stopped runtime's data directory explicitly");
  console.log(
    JSON.stringify(
      installQualifiedFollowup(
        directory,
        argument,
        command === "activate" ? Number(seed || 17) : undefined,
      ),
      null,
      2,
    ),
  );
} else
  throw new Error(
    "Use prepare, install or explicit activate. Preparation does not run an audit.",
  );
