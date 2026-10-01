import { createHash } from "node:crypto";

export function canonical(v: any): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
export const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
