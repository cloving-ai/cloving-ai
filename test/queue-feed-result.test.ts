import assert from "node:assert/strict";
import { test } from "node:test";
import { checkedFeedResult } from "../src/queue-feed.ts";

const pick = { id: "765", text: "Task" };

await test("CLV-362 feed results retain ordered picks and bounded skips", () => {
  const result = {
    picks: Array.from({ length: 20 }, (_, index) => ({
      ...pick,
      id: String(index),
    })),
    skipped: Array.from({ length: 50 }, () => ({
      id: "a".repeat(64),
      reason: "é".repeat(200),
    })),
  };
  assert.deepEqual(checkedFeedResult(result), result);
  const maximumText = {
    picks: [{ ...pick, text: "é".repeat(32_768) }],
    skipped: [],
  };
  assert.deepEqual(checkedFeedResult(maximumText), maximumText);
  assert.deepEqual(checkedFeedResult({ picks: [], skipped: [] }), {
    picks: [],
    skipped: [],
  });
});

await test("CLV-362 malformed and oversized feed results fail atomically", () => {
  const invalid = [
    null,
    [],
    {},
    { picks: [], skipped: [], extra: true },
    { picks: Array.from({ length: 21 }, () => pick), skipped: [] },
    {
      picks: [],
      skipped: Array.from({ length: 51 }, () => ({
        id: "765",
        reason: "wait",
      })),
    },
    ...["next", "", "owner/765", "a".repeat(65)].map((id) => ({
      picks: [{ ...pick, id }],
      skipped: [],
    })),
    { picks: [{ ...pick, text: "é".repeat(32_768) + "a" }], skipped: [] },
    { picks: [pick], skipped: [{ id: "765", reason: "a".repeat(201) }] },
    { picks: [pick], skipped: [{ id: "bad id", reason: "wait" }] },
    { picks: [pick], skipped: [{ id: "765", reason: 1 }] },
    { picks: [{ ...pick, extra: true }], skipped: [] },
    { picks: [], skipped: [{ id: "765", reason: "wait", extra: true }] },
    {
      picks: Array.from({ length: 4 }, () => ({
        ...pick,
        text: "a".repeat(65_536),
      })),
      skipped: [],
    },
    { picks: [{ ...pick, text: "\u0000".repeat(65_536) }], skipped: [] },
  ];
  for (const [index, value] of invalid.entries())
    assert.equal(checkedFeedResult(value), undefined, String(index));
});
