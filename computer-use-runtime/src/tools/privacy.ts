/** Reviewable text exports retain structure while dropping credentials and user text. */
export function redactPrivateValue(value: unknown): unknown {
  if (typeof value === "string") return "[REDACTED]";
  if (Array.isArray(value)) return value.map(redactPrivateValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /token|password|secret|authorization|cookie|credential|api.?key/i.test(
          key,
        )
          ? "[REDACTED]"
          : redactPrivateValue(entry),
      ]),
    );
  return value;
}

/** For explicit text sharing, strip recognizable credential formats as a second defense. */
export function redactCredentials(text: string): string {
  return text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "[REDACTED]")
    .replace(
      /\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{10,}/g,
      "[REDACTED]",
    )
    .replace(
      /((?:api.?key|access.?token|password|secret|authorization|cookie)\s*[=:]\s*)[^\s,;"']+/gi,
      "$1[REDACTED]",
    )
    .replace(/https?:\/\/[^\s/]+:[^\s/]+@[^\s]+/gi, "[REDACTED_URL]");
}
