import { test } from "node:test";
import assert from "node:assert/strict";
import { ScopedEvidenceCache } from "../src/predicates/cache.js";
import type { Observation } from "../src/contracts/index.js";
import { bitmapChangedRegion } from "../src/adapters/png.js";

test("scoped assessment reuse requires the exact source and native invalidation, while unrelated region changes preserve it", () => {
  const source: Observation = {
    schemaVersion: 1,
    id: "before",
    host: "host",
    session: "session",
    target: "target",
    at: Date.now(),
    revision: "r",
    focused: true,
    frame: { x: 0, y: 0, width: 100, height: 100, scale: 1 },
    facts: {
      canvasImage: "content-sha",
      canvasBounds: "bounds",
      nativeEventsAvailable: true,
      nativeEventSequence: 1,
      nativeEventGap: false,
      nativeEventDependencies: "[]",
      changedRegion: "null",
    },
    features: [],
    backend: "native-test",
  };
  const region = { x: 10, y: 10, width: 30, height: 30 },
    cache = new ScopedEvidenceCache<{ truth: string }>();
  const remember = () =>
    cache.remember(
      "subject-model-sha",
      { truth: "assessment-only" },
      source,
      ["canvasImage", "canvasBounds"],
      region,
    );
  remember();
  const outside = {
    ...source,
    id: "after",
    revision: "changed-caption",
    facts: {
      ...source.facts,
      changedRegion: JSON.stringify({ x: 70, y: 70, width: 10, height: 10 }),
    },
  };
  assert.equal(
    cache.get("subject-model-sha", outside)?.sourceObservationId,
    "before",
  );
  const changes: Observation["facts"][] = [
    { changedRegion: JSON.stringify({ x: 15, y: 15, width: 1, height: 1 }) },
    { nativeEventDependencies: '["value"]' },
    { nativeEventDependencies: '["unknown-event"]' },
    { nativeEventSequence: 0 },
    { nativeEventSequence: "invalid" },
    { nativeEventGap: true },
    { canvasImage: "different-sha" },
    { nativeEventsAvailable: false },
  ];
  for (const facts of changes) {
    remember();
    assert.equal(
      cache.get("subject-model-sha", {
        ...source,
        facts: { ...source.facts, ...facts },
      }),
      undefined,
    );
  }
  remember();
  assert.equal(
    cache.get("subject-model-sha", { ...source, target: "foreign" }),
    undefined,
  );
  remember();
  assert.equal(cache.get("different-model-sha", source), undefined);
});

test("raw native pixel changes produce a bounded region with correct top-down and bottom-up rows", () => {
  for (const signedHeight of [3, -3]) {
    const before = Buffer.alloc(54 + 4 * 3 * 4);
    before.write("BM");
    before.writeUInt32LE(54, 10);
    before.writeInt32LE(4, 18);
    before.writeInt32LE(signedHeight, 22);
    before.writeUInt16LE(32, 28);
    const after = Buffer.from(before),
      row = signedHeight < 0 ? 0 : 2;
    after[54 + (row * 4 + 2) * 4] = 255;
    assert.deepEqual(bitmapChangedRegion(before, after), {
      x: 2,
      y: 0,
      width: 1,
      height: 1,
    });
    assert.equal(bitmapChangedRegion(before, before), undefined);
    const changed = Buffer.from(before);
    changed.writeInt32LE(2, 18);
    assert.throws(
      () => bitmapChangedRegion(before, changed),
      /matching raw bitmap/,
    );
  }
});
