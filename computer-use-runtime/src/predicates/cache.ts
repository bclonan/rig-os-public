import type { Observation } from "../contracts/index.js";
import { canonical } from "../util/canonical.js";

type Region = { x: number; y: number; width: number; height: number };
const overlap = (a: Region, b: Region) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/** A cached assessment remains an opinion about exact source bytes. It cannot
 * authorize an action or replace Runtime's fresh independent completion check. */
export class ScopedEvidenceCache<T> {
  private entries = new Map<
    string,
    {
      value: T;
      source: Observation;
      dependencies: string[];
      region: Region;
      evaluatedAt: number;
    }
  >();
  constructor(
    private ttlMs = 600000,
    private limit = 32,
  ) {}
  remember(
    key: string,
    value: T,
    source: Observation,
    dependencies: string[],
    region: Region,
  ) {
    this.entries.delete(key);
    this.entries.set(key, {
      value: structuredClone(value),
      source: structuredClone(source),
      dependencies: [...dependencies],
      region: { ...region },
      evaluatedAt: Date.now(),
    });
    while (this.entries.size > this.limit)
      this.entries.delete(this.entries.keys().next().value!);
  }
  get(key: string, current: Observation) {
    const item = this.entries.get(key);
    if (!item) return undefined;
    const old = item.source;
    let invalid =
      Date.now() - item.evaluatedAt > this.ttlMs ||
      !current.focused ||
      current.host !== old.host ||
      current.session !== old.session ||
      current.target !== old.target ||
      canonical(current.frame) !== canonical(old.frame) ||
      current.facts.nativeEventsAvailable !== true ||
      current.facts.nativeEventGap === true ||
      !Number.isSafeInteger(old.facts.nativeEventSequence) ||
      !Number.isSafeInteger(current.facts.nativeEventSequence) ||
      Number(current.facts.nativeEventSequence) <
        Number(old.facts.nativeEventSequence) ||
      item.dependencies.some(
        (field) => current.facts[field] !== old.facts[field],
      );
    try {
      const changes = JSON.parse(
        String(current.facts.nativeEventDependencies || "[]"),
      );
      if (!Array.isArray(changes) || changes.length > 0) invalid = true;
      const region = JSON.parse(String(current.facts.changedRegion || "null"));
      if (
        region &&
        (!["x", "y", "width", "height"].every((key) =>
          Number.isFinite(region[key]),
        ) ||
          region.width < 1 ||
          region.height < 1 ||
          overlap(region, item.region))
      )
        invalid = true;
    } catch {
      invalid = true;
    }
    if (invalid) {
      this.entries.delete(key);
      return undefined;
    }
    return {
      value: structuredClone(item.value),
      evaluatedAt: item.evaluatedAt,
      sourceObservationId: old.id,
    };
  }
}
