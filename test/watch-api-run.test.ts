import assert from "node:assert/strict";
import { test } from "node:test";
import { watchApiDocument } from "../src/cli/watch-api-document.ts";
import type { Fields } from "../src/protocol.ts";
import { fields, items } from "./service-fixture.ts";
import { contractBody } from "./watch-api-contract.ts";
import {
  detailRecords,
  detailReplies,
  minutesAgo,
  pendingDecision,
  runDetail,
} from "./watch-api-fixture.ts";
import { withWatchService } from "./watch-service-fixture.ts";

async function shownRun(address: string, runId: string): Promise<Fields> {
  const response = await fetch(`${address}data.json?runId=${runId}`);
  assert.equal(response.status, 200);
  return fields(fields(await response.json())["run"]);
}

async function summaryOf(address: string, runId: string): Promise<unknown> {
  const response = await fetch(`${address}api/v1/runs`);
  const page = fields(
    await contractBody(watchApiDocument, { response, path: "/runs" }),
  );
  return items(page["runs"])
    .map(fields)
    .find((run) => run["runId"] === runId);
}

const summaryFields = [
  "runId",
  "workflowId",
  "ticketId",
  "title",
  "state",
  "outcome",
  "currentStep",
  "latestAt",
  "pullRequest",
  "estimatedCostUsd",
];

function picked(value: unknown, names: readonly string[]): Fields {
  const source = fields(value);
  return Object.fromEntries(names.map((name) => [name, source[name]]));
}

function detailOf(shown: Fields, summary: unknown): Fields {
  return {
    ...fields(summary),
    ...picked(shown, ["code", "detail", "round", "spent", "limit"]),
    decisions: items(shown["decisions"]).map((decision) =>
      picked(decision, ["decisionId", "type", "prompt"]),
    ),
    phases: items(shown["phases"]).map((phase) =>
      picked(phase, ["name", "state", "startedAt", "endedAt"]),
    ),
    reviews: items(shown["reviews"]).map((review) =>
      picked(review, ["round", "commit", "score"]),
    ),
    mergeCommit: shown["mergeCommit"],
    turns: items(shown["turns"]).map((turn) =>
      picked(turn, [
        "key",
        "harness",
        "startedAt",
        "endedAt",
        "outcome",
        "estimatedCostUsd",
        "summary",
      ]),
    ),
  };
}

await test("CLV-255 GET api/v1/runs/{runId} gives a run of the last 7 days with its summary fields, phases, decisions, reviews and turns", () =>
  withWatchService(
    { answer: detailReplies().answer, configure: detailRecords },
    async (watch) => {
      const run = await runDetail(watch.address, "run-new");
      const shown = await shownRun(watch.address, "run-new");
      const summary = await summaryOf(watch.address, "run-new");
      assert.ok(summary !== undefined);
      assert.deepEqual(run, detailOf(shown, summary));
      assert.deepEqual(
        picked(run, ["runId", "ticketId", "title", "estimatedCostUsd"]),
        {
          runId: "run-new",
          ticketId: "CLV-255",
          title: "Add the run detail",
          estimatedCostUsd: 2.5,
        },
      );
      assert.deepEqual(
        picked(run, ["code", "detail", "spent", "limit", "mergeCommit"]),
        {
          code: "decision-open",
          detail: "The design waits.",
          spent: 3,
          limit: 10,
          mergeCommit: null,
        },
      );
      assert.deepEqual(run["decisions"], [
        picked(pendingDecision, ["decisionId", "type", "prompt"]),
      ]);
      assert.deepEqual(run["turns"], [
        {
          key: "turn-1",
          harness: "claude",
          startedAt: minutesAgo(9),
          endedAt: minutesAgo(8),
          outcome: "completed",
          estimatedCostUsd: 0.75,
          summary: "Added the run detail.",
        },
      ]);
      assert.ok(items(run["phases"]).length > 0);
    },
  ));

await test("CLV-255 GET api/v1/runs/{runId} gives a run older than 7 days that the run list does not give", () =>
  withWatchService(
    { answer: detailReplies().answer, configure: detailRecords },
    async (watch) => {
      assert.equal(await summaryOf(watch.address, "run-old"), undefined);
      const run = await runDetail(watch.address, "run-old");
      const shown = await shownRun(watch.address, "run-old");
      assert.deepEqual(run, detailOf(shown, picked(shown, summaryFields)));
      assert.deepEqual(
        picked(run, ["runId", "state", "outcome", "latestAt", "mergeCommit"]),
        {
          runId: "run-old",
          state: "completed",
          outcome: "handoff_requested",
          latestAt: minutesAgo(60 * 24 * 30),
          mergeCommit: "merge-commit-1",
        },
      );
      assert.deepEqual(run["reviews"], [
        { round: 1, commit: "commit-1", score: 4 },
      ]);
      assert.deepEqual(run["decisions"], []);
      assert.deepEqual(run["turns"], []);
    },
  ));

await test("CLV-255 no run response of the API contains the approve or deny command of a decision", () =>
  withWatchService(
    { answer: detailReplies().answer, configure: detailRecords },
    async (watch) => {
      const shown = await shownRun(watch.address, "run-new");
      const texts = items(shown["decisions"]).flatMap((decision) =>
        Object.values(picked(decision, ["approve", "deny"])),
      );
      assert.equal(texts.length, 2);
      assert.ok(
        texts.every((text) => String(text).includes("run-new/design-1")),
      );
      for (const [path, shownText] of [
        ["api/v1/runs", "run-new"],
        ["api/v1/runs/run-new", pendingDecision.prompt],
        ["api/v1/runs/run-new/events", "run.paused"],
      ] as const) {
        const response = await fetch(`${watch.address}${path}`);
        assert.equal(response.status, 200, path);
        const body = await response.text();
        assert.ok(body.includes(shownText), path);
        for (const text of [
          ...texts,
          "--expected-revision",
          "--subject-digest",
        ])
          assert.ok(!body.includes(String(text)), `${path}: ${String(text)}`);
      }
    },
  ));
