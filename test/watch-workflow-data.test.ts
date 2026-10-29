import assert from "node:assert/strict";
import { test } from "node:test";
import { fields, items } from "./service-fixture.ts";
import { configuredPrWatch } from "./watch-pr-cli-fixture.ts";
import {
  mergeJournal,
  mergedJournal,
  mergeRepository,
  writeMergeRecords,
} from "./watch-merge-fixture.ts";
import {
  watchData,
  watchReplies,
  withWatchService,
} from "./watch-service-fixture.ts";

for (const workflowId of ["develop", "custom-workflow"]) {
  await test(`CLV-227 data.json retains the PR, review score and merge proof for ${workflowId}`, async () => {
    const replies = watchReplies({
      workflows: [workflowId],
      runs: [
        {
          runId: "A",
          workflowId,
          state: "completed",
          latestSequence: 0,
          outcome: { kind: "handoff_requested" },
          latestAt: new Date().toISOString(),
        },
      ],
    });
    await withWatchService(
      {
        answer: replies.answer,
        configure: async (runtime) => {
          await writeMergeRecords(runtime, [
            ...mergedJournal("A"),
            mergeJournal("A", {
              method: "wait-review",
              report: { number: 7, score: 5, commit: "fixture-commit" },
            }),
            ...mergedJournal("another-run"),
          ]);
          return configuredPrWatch(runtime);
        },
      },
      async (watch) => {
        const data = await watchData(watch.address);
        const run = fields(items(data["runs"])[0]);
        assert.equal(fields(run["pullRequest"])["number"], 7);
        assert.equal(fields(items(run["reviews"])[0])["score"], 5);
        assert.deepEqual(run["mergeProof"], { ...mergeRepository, number: 7 });
        const workflow = fields(items(data["workflows"])[0]);
        const cards = items(workflow["columns"]).flatMap((column) =>
          items(fields(column)["cards"]),
        );
        const card = fields(cards[0]);
        assert.equal(card["pullRequestNumber"], 7);
        assert.equal(card["greptileScore"], 5);
        assert.deepEqual(card["completionMark"], {
          text: "PR merged · #7",
          laterRunId: null,
        });
      },
    );
  });
}
