import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fields, Reply, ServiceRequest } from "../src/protocol.ts";
import { digestOf } from "./digest-fixture.ts";
import {
  effectEvents,
  reportReply,
  withReportSource,
} from "./report-fixture.ts";
import { fields, items, parsed } from "./service-fixture.ts";

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
