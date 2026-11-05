import assert from "node:assert/strict";
import { test } from "node:test";
import { dueBundles } from "../src/record-retention.ts";

const day = 86_400_000;
const now = Date.parse("2026-11-04T00:00:00.000Z");

function digest(letter: string): string {
  return letter.repeat(64);
}

function bundle(letter: string, daysAgo: number) {
  return { digest: digest(letter), currentAt: now - daysAgo * day };
}

const bundles = [
  bundle("a", 40),
  bundle("b", 400),
  bundle("c", 400),
  bundle("d", 29),
  bundle("e", 31),
];

await test("CLV-295 an old bundle with no unfinished run that is not current is due", () => {
  assert.deepEqual(
    dueBundles([bundle("a", 31)], {
      current: undefined,
      pinned: [],
      now,
      days: 30,
    }),
    [digest("a")],
  );
});

await test("CLV-295 a pinned bundle and the current bundle stay at any age, and a recent bundle stays", () => {
  assert.deepEqual(
    dueBundles(bundles, {
      current: digest("c"),
      pinned: [digest("b")],
      now,
      days: 30,
    }),
    [digest("a"), digest("e")],
  );
});

await test("CLV-295 a bundle that was current exactly at the limit stays", () => {
  assert.deepEqual(
    dueBundles([bundle("a", 30)], {
      current: undefined,
      pinned: [],
      now,
      days: 30,
    }),
    [],
  );
});

await test("CLV-295 a bundle with an unknown time stays", () => {
  assert.deepEqual(
    dueBundles([{ digest: digest("a"), currentAt: Number.NaN }], {
      current: undefined,
      pinned: [],
      now,
      days: 30,
    }),
    [],
  );
});

await test("CLV-295 retention days null keeps all bundles", () => {
  assert.deepEqual(
    dueBundles(bundles, {
      current: undefined,
      pinned: [],
      now,
      days: null,
    }),
    [],
  );
});
