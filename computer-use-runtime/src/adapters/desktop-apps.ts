import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

// Only these fixed executables can be launched. No model-supplied paths,
// arguments, URLs, command interpreters, or shell string interpolation.
const definitions = [
  {
    id: "calculator",
    name: "Calculator",
    file: "System32/calc.exe",
    executables: ["calculatorapp.exe", "calc.exe"],
  },
  {
    id: "notepad",
    name: "Notepad",
    file: "System32/notepad.exe",
    executables: ["notepad.exe"],
  },
  {
    id: "paint",
    name: "Paint",
    file: "System32/mspaint.exe",
    alias: "mspaint.exe",
    executables: ["mspaint.exe"],
  },
  {
    id: "explorer",
    name: "File Explorer",
    file: "explorer.exe",
    executables: ["explorer.exe"],
  },
];
export function desktopApps() {
  if (process.platform === "darwin")
    return [
      {
        id: "calculator",
        name: "Calculator",
        path: "/System/Applications/Calculator.app",
        executables: ["calculator"],
      },
      {
        id: "editor",
        name: "TextEdit",
        path: "/System/Applications/TextEdit.app",
        executables: ["textedit"],
      },
      {
        id: "files",
        name: "Finder",
        path: "/System/Library/CoreServices/Finder.app",
        executables: ["finder"],
      },
      {
        id: "preview",
        name: "Preview",
        path: "/System/Applications/Preview.app",
        executables: ["preview"],
      },
    ].filter((app) => existsSync(app.path));
  if (process.platform === "linux") {
    const choices = [
      {
        id: "calculator",
        programs: ["gnome-calculator", "galculator", "kcalc"],
      },
      {
        id: "editor",
        programs: [
          "gnome-text-editor",
          "gedit",
          "mousepad",
          "kate",
          "kwrite",
          "pluma",
          "xed",
        ],
      },
      {
        id: "files",
        programs: ["nautilus", "thunar", "dolphin", "pcmanfm", "nemo"],
      },
    ];
    return choices.flatMap(({ id, programs }) => {
      const program = programs.find((p) => existsSync("/usr/bin/" + p));
      return program
        ? [
            {
              id,
              name: program,
              path: "/usr/bin/" + program,
              executables: [program],
            },
          ]
        : [];
    });
  }
  if (process.platform !== "win32") return [];
  return definitions.flatMap((app) => {
    const system = join(process.env.SystemRoot || "C:\\Windows", app.file);
    const alias =
      app.alias && process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", app.alias)
        : undefined;
    let installedAlias = false;
    try {
      // App execution aliases are special reparse points; stat/exists follows them and can return EACCES.
      installedAlias = Boolean(alias && lstatSync(alias).isSymbolicLink());
    } catch {}
    const path = existsSync(system)
      ? system
      : installedAlias
        ? alias
        : undefined;
    return path ? [{ ...app, path }] : [];
  });
}
export async function launchDesktopApp(id: string) {
  const app = desktopApps().find((a) => a.id === id);
  if (!app) throw new Error("This app is not available in the launcher");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.platform === "darwin" ? "/usr/bin/open" : app.path,
      process.platform === "darwin" ? ["-a", app.path] : [],
      {
        shell: false,
        // These are explicitly requested interactive apps, not background workers.
        windowsHide: false,
        detached: true,
        stdio: "ignore",
      },
    );
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
