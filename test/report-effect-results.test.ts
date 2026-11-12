import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fields } from "../src/protocol.ts";
import { reportReviewScores } from "../src/report-effects.ts";
import { loopReport } from "../src/report.ts";
import { digestOf } from "./digest-fixture.ts";
import { effectEvents } from "./report-fixture.ts";
import { fields, items } from "./service-fixture.ts";

const at = Date.parse("2026-10-24T12:00:00Z");
const now = at + 3_600_000;

interface StoredEffect {
  readonly events: readonly Fields[];
  readonly digest: string;
  readonly results: Readonly<Record<string, { readonly body: string }>>;
}

function storedEffect(
  runId: string,
  input: Parameters<typeof effectEvents>[1],
): StoredEffect {
  const [requested, reported] = effectEvents(runId, input);
  const body = JSON.stringify(input.result ?? {});
  const digest = digestOf(body);
  const requestPayload = fields(requested?.["payload"]);
  return {
    events: [
      {
        ...requested,
        payload: {
          ...requestPayload,
          payload: digestOf(String(requestPayload["payload"])),
        },
      },
      {
        ...reported,
        payload: { ...fields(reported?.["payload"]), result: digest },
      },
    ],
    digest,
    results: { [digest]: { body } },
  };
}

function resultsOf(stored: readonly StoredEffect[]) {
  return Object.fromEntries(
    stored.flatMap((effect) => Object.entries(effect.results)),
  );
}

function reviews(): readonly StoredEffect[] {
  return [
    storedEffect("first", {
      method: "wait-review",
      sequence: 1,
      at,
      result: { number: 8, score: 5 },
    }),
    storedEffect("second", {
      method: "wait-review",
      sequence: 3,
      at,
      result: { number: 9, score: 4 },
    }),
  ];
}

await test("CLV-351 review scores come from the stored results of the wait-review reports", () => {
  const stored = reviews();
  const rounds = reportReviewScores(
    stored.flatMap((effect) => effect.events),
    resultsOf(stored),
  );
  assert.deepEqual(
    rounds?.["round1"]?.map((datum) => [datum.value, datum.evidence["score"]]),
    [
      [5, 5],
      [4, 4],
    ],
  );
});

await test("CLV-351 the loop report gives the stored review scores in quality.reviewScore", () => {
  const stored = reviews();
  const report = loopReport({
    since: 24,
    now,
    completions: [],
    effects: stored.flatMap((effect) => effect.events),
    effectResults: resultsOf(stored),
  });
  const round = fields(
    fields(fields(fields(report)["quality"])["reviewScore"])["round1"],
  );
  assert.equal(round["value"], 4.5);
  assert.deepEqual(
    items(round["evidence"]).map((item) => fields(item)["score"]),
    [5, 4],
  );
});

function mergedRun(runId: string, number: number): readonly StoredEffect[] {
  return [
    storedEffect(runId, {
      method: "open-pr",
      sequence: number * 10 + 1,
      at,
      result: { number },
    }),
    storedEffect(runId, { method: "run-turn", sequence: number * 10 + 3, at }),
    storedEffect(runId, {
      method: "merge",
      sequence: number * 10 + 5,
      at,
      payload: { number },
      result: { number, commit: "b".repeat(40), merged: "a".repeat(40) },
    }),
  ];
}

function pulls(numbers: readonly number[]) {
  return numbers.map((number) => ({
    at,
    value: 1,
    evidence: { pullRequest: number },
  }));
}

function mergeReport(
  stored: readonly StoredEffect[],
  effectResults: Readonly<Record<string, unknown>> = resultsOf(stored),
) {
  return loopReport({
    since: 24,
    now,
    completions: [],
    observedSince: 0,
    effects: stored.flatMap((effect) => effect.events),
    effectResults: Object.fromEntries(
      Object.entries(effectResults).map(([digest, value]) => [
        digest,
        fields(value)["body"] === undefined
          ? { reason: String(fields(value)["reason"]) }
          : { body: String(fields(value)["body"]) },
      ]),
    ),
    github: {
      issues: [],
      pulls: pulls([8, 9]),
      sources: {},
      observedSince: 0,
    },
  });
}

await test("CLV-351 fix rounds and operator merges count a merge whose result is a stored document", () => {
  const report = mergeReport(mergedRun("merged", 8));
  const rounds = fields(
    fields(report.metrics)["fixRounds.medianPerMergedPullRequest"],
  );
  assert.equal(rounds["value"], 1);
  assert.deepEqual(items(rounds["evidence"]).map(fields), [
    {
      runId: "merged",
      pullRequest: 8,
      operationId: "merged-85",
      fixRounds: 1,
    },
  ]);
  assert.equal(report.operator.merges.value, 1);
  assert.deepEqual(report.operator.merges.evidence, [{ pullRequest: 9 }]);
});

function withoutResult(
  results: Readonly<Record<string, unknown>>,
  digest: string | undefined,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(results).filter(([key]) => key !== digest),
  );
}

await test("CLV-351 a review result with no stored document gives a null score with a reason and keeps the other scores", () => {
  const stored = reviews();
  const missing = stored[1]?.digest;
  const results = Object.fromEntries(
    Object.entries(withoutResult(resultsOf(stored), missing)).map(
      ([digest, value]) => [digest, { body: String(fields(value)["body"]) }],
    ),
  );
  const rounds = reportReviewScores(
    stored.flatMap((effect) => effect.events),
    results,
  );
  assert.deepEqual(
    rounds?.["round1"]?.map((datum) => [
      datum.value,
      datum.evidence["score"],
      datum.evidence["reason"],
    ]),
    [
      [5, 5, undefined],
      [null, null, "effect-result-not-read"],
    ],
  );
  const refused = reportReviewScores(
    stored.flatMap((effect) => effect.events),
    { ...results, [String(missing)]: { reason: "unknown-effect-result" } },
  );
  assert.equal(
    refused?.["round1"]?.[1]?.evidence["reason"],
    "unknown-effect-result",
  );
});

await test("CLV-351 malformed stored review results preserve the other scores", () => {
  const stored = reviews();
  for (const body of ["{", "null", "[]", '"score: 4"']) {
    const rounds = reportReviewScores(
      stored.flatMap((effect) => effect.events),
      {
        ...resultsOf(stored),
        [String(stored[1]?.digest)]: { body },
      },
    );
    assert.deepEqual(
      rounds?.["round1"]?.map((datum) => [
        datum.value,
        datum.evidence["score"],
        datum.evidence["reason"],
      ]),
      [
        [5, 5, undefined],
        [null, null, "invalid-effect-result"],
      ],
      body,
    );
  }
});

await test("CLV-351 malformed stored merge results preserve the other merge data", () => {
  const stored = [...mergedRun("merged", 8), ...mergedRun("invalid", 9)];
  const report = mergeReport(stored, {
    ...resultsOf(stored),
    [String(stored.at(-1)?.digest)]: { body: "{" },
  });
  const rounds = items(
    fields(fields(report.metrics)["fixRounds.medianPerMergedPullRequest"])[
      "evidence"
    ],
  ).map(fields);
  assert.deepEqual(
    rounds.map((item) => [item["runId"], item["fixRounds"], item["reason"]]),
    [
      ["merged", 1, undefined],
      ["invalid", null, "invalid-effect-result"],
    ],
  );
  assert.equal(report.operator.merges.value, null);
  assert.deepEqual(report.operator.merges.evidence, [
    { pullRequest: 9, reason: "invalid-effect-result" },
  ]);
});

await test("CLV-351 a merge result with no stored document gives null data with a reason and keeps the other data", () => {
  const stored = [...mergedRun("merged", 8), ...mergedRun("missing", 9)];
  const missing = stored.at(-1)?.digest;
  const report = mergeReport(stored, withoutResult(resultsOf(stored), missing));
  const rounds = items(
    fields(fields(report.metrics)["fixRounds.medianPerMergedPullRequest"])[
      "evidence"
    ],
  ).map(fields);
  assert.deepEqual(
    rounds.map((item) => [item["runId"], item["fixRounds"], item["reason"]]),
    [
      ["merged", 1, undefined],
      ["missing", null, "effect-result-not-read"],
    ],
  );
  assert.equal(report.operator.merges.value, null);
  assert.deepEqual(report.operator.merges.evidence, [
    { pullRequest: 9, reason: "effect-result-not-read" },
  ]);
});

await test("CLV-351 an unread merge result with a known pull request makes only that pull request unknown", () => {
  const unread = effectEvents("unread", {
    method: "merge",
    sequence: 1,
    at,
    payload: { number: 9 },
  });
  const report = mergeReport([
    {
      events: [
        ...unread.slice(0, 1),
        {
          ...unread[1],
          payload: {
            ...fields(unread[1]?.["payload"]),
            result: digestOf("missing"),
          },
        },
      ],
      digest: digestOf("missing"),
      results: {},
    },
  ]);
  assert.equal(report.operator.merges.value, null);
  assert.deepEqual(report.operator.merges.evidence, [
    { pullRequest: 8 },
    { pullRequest: 9, reason: "effect-result-not-read" },
  ]);
});
