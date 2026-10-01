import { NativeClient } from "../src/adapters/native.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hash } from "../src/storage/index.js";
import { bitmapToPng } from "../src/adapters/png.js";
import { setTimeout as delay } from "node:timers/promises";

const handle = Number(process.argv[2]);
if (!Number.isSafeInteger(handle) || handle <= 0)
  throw new Error("Provide the disposable Paint handle from the failed report");
const directory = resolve(
  "evidence/completion/paint-stability",
  String(Date.now()),
);
mkdirSync(directory, { recursive: true });
const client = new NativeClient();
const report: any = {
  handle,
  samples: [],
  purpose:
    "Read-only diagnosis of repeated preflight content rejection in owned Paint document",
};
try {
  await client.call("focus", { handle });
  await delay(1500);
  let previous: Buffer | undefined;
  for (let i = 0; i < 8; i++) {
    const controlsBefore = await client.call("accessibility", { handle });
    const observation = await client.call("observe", { handle });
    const controlsAfter = await client.call("accessibility", { handle });
    const bytes = Buffer.from(observation.image, "base64");
    const width = bytes.readInt32LE(18);
    let rgbPixels = 0,
      alphaBytes = 0,
      minX = width,
      minY = 10000,
      maxX = -1,
      maxY = -1;
    if (previous && previous.length === bytes.length)
      for (let index = 54; index < bytes.length; index += 4) {
        if (bytes[index + 3] !== previous[index + 3]) alphaBytes++;
        if (
          !bytes
            .subarray(index, index + 3)
            .equals(previous.subarray(index, index + 3))
        ) {
          rgbPixels++;
          const pixel = (index - 54) / 4,
            x = pixel % width,
            y = Math.floor(pixel / width);
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    const png = bitmapToPng(bytes);
    writeFileSync(resolve(directory, i + ".png"), png);
    report.samples.push({
      at: observation.at,
      rawHash: hash(bytes),
      pngHash: hash(png),
      rgbPixels,
      alphaBytes,
      changedBounds: rgbPixels ? { minX, minY, maxX, maxY } : null,
      controlsStable:
        JSON.stringify(controlsBefore) === JSON.stringify(controlsAfter),
      changedControls: controlsBefore
        .filter(
          (control: any, index: number) =>
            JSON.stringify(control) !== JSON.stringify(controlsAfter[index]),
        )
        .map((control: any, index: number) => ({
          before: control,
          after: controlsAfter[index],
        })),
    });
    previous = bytes;
    await delay(130);
  }
} finally {
  await client.close();
  writeFileSync(
    resolve(directory, "results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ directory, ...report }));
}
