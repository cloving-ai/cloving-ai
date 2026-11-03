import assert from "node:assert/strict";
import { test } from "node:test";
import { watchApiDocument } from "../src/cli/watch-api-document.ts";
import type { Fields } from "../src/protocol.ts";
import { fields, items } from "./service-fixture.ts";
import { contractBody } from "./watch-api-contract.ts";
import {
  mergeJournal,
  mergePull,
  writeMergeRecords,
} from "./watch-merge-fixture.ts";
import {
  watchData,
  watchReplies,
  withWatchService,
} from "./watch-service-fixture.ts";

const now = Date.now();

function minutesAgo(minutes: number): string {
  return new Date(now - minutes * 60000).toISOString();
}

async function runPage(
  address: string,
  query: string,
): Promise<{ readonly runs: readonly Fields[]; readonly next: unknown }> {
  const response = await fetch(`${address}api/v1/runs${query}`);
  assert.equal(response.status, 200, query);
  const page = fields(
    await contractBody(watchApiDocument, { response, path: "/runs" }),
  );
  return { runs: items(page["runs"]).map(fields), next: page["nextCursor"] };
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

function summaryReplies(): ReturnType<typeof watchReplies> {
  return watchReplies({
    workflows: ["develop", "develop-issue"],
    runs: [
      {
        runId: "run-a",
        workflowId: "develop",
        state: "waiting_gate",
        latestSequence: 1,
        latestAt: minutesAgo(1),
        ticketId: "CLV-254",
        title: "Add the API",
        estimatedCostUsd: 1.25,
      },
      {
        runId: "run-b",
        workflowId: "develop",
        state: "completed",
        latestSequence: 0,
        latestAt: minutesAgo(2),
        outcome: { kind: "handoff_requested" },
      },
      {
        runId: "run-c",
        workflowId: "develop-issue",
        state: "queued",
        latestSequence: 0,
      },
      {
        runId: "run-old",
        workflowId: "develop",
        state: "completed",
        latestSequence: 0,
        latestAt: minutesAgo(60 * 24 * 30),
      },
    ],
    eventsByRun: {
      "run-a": [
        {
          sequence: 1,
          recordedAt: minutesAgo(3),
          type: "run.created",
          payload: {},
        },
      ],
    },
  });
}

await test("CLV-254 GET api/v1/runs gives the runs of the page model with the summary fields of each run, newest first", async () => {
  const replies = summaryReplies();
  await withWatchService(
    {
      answer: replies.answer,
      configure: async (runtime) => {
        await writeMergeRecords(runtime, [
          mergeJournal("run-a", { method: "open-pr", report: mergePull }),
        ]);
        return {};
      },
    },
    async (watch) => {
      const page = await runPage(watch.address, "");
      assert.deepEqual(
        page.runs.map((run) => run["runId"]),
        ["run-a", "run-b", "run-c"],
      );
      assert.equal(page.next, null);
      assert.deepEqual(page.runs[0], {
        runId: "run-a",
        workflowId: "develop",
        ticketId: "CLV-254",
        title: "Add the API",
        state: "waiting_gate",
        outcome: null,
        currentStep: page.runs[0]?.["currentStep"],
        latestAt: minutesAgo(1),
        pullRequest: mergePull,
        estimatedCostUsd: 1.25,
      });
      assert.deepEqual(
        [page.runs[1]?.["outcome"], page.runs[2]?.["latestAt"]],
        ["handoff_requested", null],
      );
      const model = await watchData(watch.address);
      const shown = items(model["runs"]).map(fields);
      for (const run of page.runs)
        assert.deepEqual(
          run,
          Object.fromEntries(
            summaryFields.map((name) => [
              name,
              shown.find((item) => item["runId"] === run["runId"])?.[name],
            ]),
          ),
        );
    },
  );
});

function pageRun(runId: string, latestAt: string | null): Fields {
  return {
    runId,
    workflowId: "develop",
    state: latestAt === null ? "running" : "completed",
    latestSequence: 0,
    latestAt,
  };
}

await test("CLV-254 five runs with limit=2 give three pages with each run one time, newest first, the lower runId first for an equal latestAt and a null latestAt last", async () => {
  const replies = watchReplies({
    workflows: ["develop"],
    runs: [
      pageRun("run-a", null),
      pageRun("run-b", minutesAgo(2)),
      pageRun("run-c", minutesAgo(3)),
      pageRun("run-d", minutesAgo(2)),
      pageRun("run-e", minutesAgo(1)),
    ],
  });
  await withWatchService(replies.answer, async (watch) => {
    const first = await runPage(watch.address, "?limit=2");
    const after = (page: typeof first): string => `cursor=${String(page.next)}`;
    const second = await runPage(watch.address, `?limit=2&${after(first)}`);
    const third = await runPage(watch.address, `?${after(second)}&limit=2`);
    assert.deepEqual(
      [first, second, third].map((page) =>
        page.runs.map((run) => run["runId"]),
      ),
      [["run-e", "run-b"], ["run-d", "run-c"], ["run-a"]],
    );
    assert.match(String(first.next), /^[A-Za-z0-9_-]+$/);
    assert.equal(third.next, null);
    const rest = await runPage(watch.address, `?${after(first)}`);
    assert.deepEqual(
      rest.runs.map((run) => run["runId"]),
      ["run-d", "run-c", "run-a"],
    );
  });
});

await test("CLV-254 GET api/v1/runs with workflowId and state gives only the matching runs, in pages", async () => {
  const replies = watchReplies({
    workflows: ["develop", "develop-issue"],
    runs: [
      { ...pageRun("gate-1", minutesAgo(1)), state: "waiting_gate" },
      { ...pageRun("gate-2", minutesAgo(2)), state: "waiting_gate" },
      { ...pageRun("gate-3", minutesAgo(3)), state: "waiting_gate" },
      { ...pageRun("working", minutesAgo(1)), state: "running" },
      {
        ...pageRun("other-gate", minutesAgo(1)),
        workflowId: "develop-issue",
        state: "waiting_gate",
      },
    ],
  });
  await withWatchService(replies.answer, async (watch) => {
    const query = "?workflowId=develop&state=waiting_gate&limit=2";
    const first = await runPage(watch.address, query);
    const second = await runPage(
      watch.address,
      `${query}&cursor=${String(first.next)}`,
    );
    assert.deepEqual(
      [first, second].map((page) => page.runs.map((run) => run["runId"])),
      [["gate-1", "gate-2"], ["gate-3"]],
    );
    assert.equal(second.next, null);
    const issue = await runPage(watch.address, "?workflowId=develop-issue");
    assert.deepEqual(
      issue.runs.map((run) => run["runId"]),
      ["other-gate"],
    );
    const running = await runPage(watch.address, "?state=running");
    assert.deepEqual(
      running.runs.map((run) => run["runId"]),
      ["working"],
    );
  });
});
