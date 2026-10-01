import { NativeClient } from "../src/adapters/native.js";
const client = new NativeClient();
try {
  const windows = await client.call("windows");
  const matches = windows.filter(
    (w: any) => w.title === (process.argv[2] || "Calculator"),
  );
  if (matches.length !== 1)
    throw new Error("Target selection must identify exactly one window");
  console.log(
    JSON.stringify(
      {
        window: matches[0],
        elements: await client.call("accessibility", {
          handle: matches[0].handle,
        }),
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
