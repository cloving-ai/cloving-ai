import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Fields, Reply, ServiceRequest } from "../src/protocol.ts";
import { readReportEffectResults } from "../src/cli/report-results.ts";
import { reportCommand } from "../src/cli/report.ts";
import { digestOf } from "./digest-fixture.ts";
import {
  effectEvents,
  reportReply,
  withReportSource,
} from "./report-fixture.ts";
import { fields, items, parsed } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const at = Date.now() - 3_600_000;

function storedEvents(
  runId: string,
  input: Parameters<typeof effectEvents>[1],
): Fields[] {
  const [requested, reported] = effectEvents(runId, input);
  return [
    { ...requested },
    {
      ...reported,
      payload: {
        ...fields(reported?.["payload"]),
        result: digestOf(JSON.stringify(input.result ?? {})),
      },
    },
  ];
}

const scored = { number: 8, score: 5 };
const merged = { number: 8, merged: "a".repeat(40) };
const events = [
  ...storedEvents("scored", {
    method: "wait-review",
    sequence: 1,
    at,
    result: scored,
  }),
  ...storedEvents("missing", {
    method: "wait-review",
    sequence: 3,
    at,
    result: { number: 9, score: 4 },
  }),
  ...storedEvents("scored", {
    method: "run-turn",
    sequence: 5,
    at,
    result: { summary: "done" },
  }),
  ...storedEvents("scored", { method: "open-pr", sequence: 7, at }),
  ...storedEvents("scored", {
    method: "merge",
    sequence: 9,
    at,
    result: merged,
  }),
];

function storedReply(request: ServiceRequest): Reply {
  if (request.operation !== "effect-result")
    return reportReply(events)(request);
  const body = [scored, merged]
    .map((result) => JSON.stringify(result))
    .find((text) => digestOf(text) === request.parameters["digest"]);
  return body === undefined
    ? {
        kind: "error",
        error: {
          code: "unknown-effect-result",
          detail: "No effect report names it.",
        },
      }
    : {
        kind: "result",
        result: { kind: "effect-result", ...request.parameters, result: body },
      };
}

await test("CLV-351 cloving report reads the stored review and merge results through the service", async () => {
  await withReportSource(storedReply, async (harness, requests) => {
    const output = await harness.cli(["report", "--since", "24", "--json"]);
    assert.equal(output.status, 0, output.stdout + output.stderr);
    const report = parsed(output);
    const round = fields(
      fields(fields(report["quality"])["reviewScore"])["round1"],
    );
    assert.deepEqual(
      items(round["evidence"]).map((item) => [
        fields(item)["runId"],
        fields(item)["score"],
        fields(item)["reason"],
      ]),
      [
        ["scored", 5, undefined],
        ["missing", null, "unknown-effect-result"],
      ],
    );
    const rounds = fields(
      fields(report["metrics"])["fixRounds.medianPerMergedPullRequest"],
    );
    assert.equal(rounds["value"], 0);
    assert.equal(fields(items(rounds["evidence"])[0])["pullRequest"], 8);
    assert.deepEqual(
      requests
        .filter((request) => request.operation === "effect-result")
        .map((request) => request.parameters),
      [
        { runId: "scored", digest: digestOf(JSON.stringify(scored)) },
        {
          runId: "missing",
          digest: digestOf(JSON.stringify({ number: 9, score: 4 })),
        },
        { runId: "scored", digest: digestOf(JSON.stringify(merged)) },
      ],
    );
  });
});

await test("CLV-351 stored result reads reject non-string run IDs before deduplication", async () => {
  const valid = storedEvents("valid", {
    method: "wait-review",
    sequence: 1,
    at,
    result: scored,
  });
  const invalid = [undefined, null, 8, { id: "valid" }].flatMap((runId) =>
    valid.map((event) => ({ ...event, runId })),
  );
  await withReportSource(storedReply, async (harness, requests) => {
    const results = await readReportEffectResults(harness.runtimeDirectory, {
      effects: [...invalid, ...valid],
      window: { start: 0, end: Date.now() },
    });
    const digest = digestOf(JSON.stringify(scored));
    assert.deepEqual(results, { [digest]: { body: JSON.stringify(scored) } });
    assert.deepEqual(
      requests.map((request) => request.parameters),
      [{ runId: "valid", digest }],
    );
  });
});

await test("CLV-351 short reports read review results within the window and baseline and retain older merges", async () => {
  const now = Date.now();
  const history = [
    ["current", "wait-review", -170 * 3_600_000],
    ["before-baseline", "wait-review", -169 * 3_600_000 - 1],
    ["baseline-start", "wait-review", -169 * 3_600_000],
    ["window-start", "wait-review", -3_600_000],
    ["current", "wait-review", -1_800_000],
    ["older-merge", "merge", -170 * 3_600_000],
    ["window-end", "wait-review", 0],
    ["future-merge", "merge", 1],
  ] as const;
  const source = history.flatMap(([runId, method, offset], index) =>
    storedEvents(runId, {
      method,
      sequence: index * 2 + 1,
      at: now + offset,
      minutes: 0,
      result: { number: index, score: 5 },
    }),
  );
  await withReportSource(
    (request) =>
      request.operation === "effect-result"
        ? { kind: "result", result: { result: JSON.stringify(scored) } }
        : reportReply(source)(request),
    async (harness, requests) => {
      const output: string[] = [];
      await reportCommand(
        { since: 1, json: true },
        {
          now,
          runtimeDirectory: harness.runtimeDirectory,
          workingDirectory: harness.projectDirectory,
          terminal: { out: (text) => output.push(text) },
        },
      );
      assert.deepEqual(
        requests
          .filter((request) => request.operation === "effect-result")
          .map((request) => request.parameters["runId"]),
        ["baseline-start", "window-start", "current", "older-merge"],
      );
      const report = fields(JSON.parse(output.join("")));
      const scores = fields(fields(report["quality"])["reviewScore"]);
      assert.equal(fields(scores["round2"])["value"], 5);
      assert.deepEqual(
        items(fields(fields(scores["round1"])["baseline"])["evidence"]).map(
          (item) => [fields(item)["runId"], fields(item)["score"]],
        ),
        [["baseline-start", 5]],
      );
    },
  );
});

await test("CLV-351 stored result reads run at most four requests in parallel and keep individual errors", async () => {
  const source = Array.from({ length: 9 }, (_, index) =>
    storedEvents(`run-${String(index)}`, {
      method: "wait-review",
      sequence: index * 2 + 1,
      at,
      result: { index },
    }),
  ).flat();
  let active = 0;
  let peak = 0;
  const firstBatch = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  await withReportSource(
    async (request) => {
      active += 1;
      peak = Math.max(peak, active);
      if (active === 4) firstBatch.resolve(undefined);
      await release.promise;
      active -= 1;
      return request.parameters["runId"] === "run-4"
        ? { kind: "result", result: { result: null } }
        : storedReply(request);
    },
    async (harness, requests) => {
      const reading = readReportEffectResults(harness.runtimeDirectory, {
        effects: source,
        window: { start: 0, end: Date.now() },
      });
      const guard = setTimeout(
        firstBatch.resolve,
        testMilliseconds(5000),
        undefined,
      );
      try {
        await firstBatch.promise;
        await nextTurn();
      } finally {
        clearTimeout(guard);
        release.resolve(undefined);
      }
      const results = await reading;
      assert.equal(peak, 4);
      assert.equal(requests.length, 9);
      assert.equal(Object.keys(results).length, 9);
      assert.deepEqual(results[digestOf(JSON.stringify({ index: 4 }))], {
        reason: "invalid-effect-result",
      });
      assert.deepEqual(results[digestOf(JSON.stringify({ index: 8 }))], {
        reason: "unknown-effect-result",
      });
    },
  );
});
