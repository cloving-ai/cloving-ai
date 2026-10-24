import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fields, items } from "./service-fixture.ts";
import { mergedJournal, writeMergeRecords } from "./watch-merge-fixture.ts";
import {
  configuredPrWatch,
  ghRequest,
  recordedPrJournal,
  releasePr,
  stoppedPrCard,
  stoppedPrRun,
  waitForPrObservation,
} from "./watch-pr-cli-fixture.ts";
import {
  watchData,
  watchReplies,
  withWatchService,
} from "./watch-service-fixture.ts";

await test("CLV-129 configured local origin validates a local merge before any GitHub read", async () => {
  const replies = watchReplies({ runs: [stoppedPrRun()] });
  await withWatchService(
    {
      answer: replies.answer,
      configure: async (runtime) => {
        await writeMergeRecords(runtime, mergedJournal("stopped"));
        return configuredPrWatch(runtime);
      },
    },
    async (watch, runtime) => {
      const model = await watchData(watch.address);
      assert.deepEqual(stoppedPrCard(model)["completionMark"], {
        text: "PR merged · #7",
        laterRunId: null,
      });
      assert.equal(stoppedPrCard(model)["pullRequestObservation"], null);
      assert.equal(fields(items(model["runs"])[0])["outcome"], "blocked");
      await assert.rejects(readFile(join(dirname(runtime), "gh-request")), {
        code: "ENOENT",
      });
    },
  );
});

await test("CLV-093 CLI board returns while configured GitHub waits and a later load sees its merge without local writes or events", async () => {
  const stopped = stoppedPrRun();
  const replies = watchReplies({
    runs: [stopped],
    events: [
      { sequence: 1, type: "run.completed", recordedAt: stopped.latestAt },
    ],
  });
  await withWatchService(
    { answer: replies.answer, configure: configuredPrWatch },
    async (watch, runtime) => {
      await recordedPrJournal(runtime);
      const journal = join(dirname(runtime), "github/pr-7/result.json");
      const before = await readFile(journal, "utf8");
      const selected = await fetch(`${watch.address}data.json?runId=stopped`);
      assert.equal(selected.status, 200);
      await assert.rejects(readFile(join(dirname(runtime), "gh-request")), {
        code: "ENOENT",
      });
      const first = await watchData(watch.address);
      assert.deepEqual(stoppedPrCard(first)["completionMark"], {
        text: "Needs attention",
        laterRunId: null,
      });
      assert.deepEqual(stoppedPrCard(first)["pullRequestObservation"], {
        status: "pending",
      });
      assert.deepEqual(await ghRequest(runtime), [
        "prefix with spaces",
        "api",
        "--method",
        "GET",
        "--hostname",
        "github.example",
        "repos/fixture/demo/pulls/7",
        "--include",
      ]);
      await releasePr(runtime, true);
      await waitForPrObservation(watch, { status: "merged" });
      const later = await watchData(watch.address);
      const run = fields(items(later["runs"])[0]);
      assert.equal(run["state"], "completed");
      assert.deepEqual(run["outcome"], "blocked");
      assert.deepEqual(items(first["runs"]), items(later["runs"]));
      assert.equal(await readFile(journal, "utf8"), before);
      assert.ok(
        replies.requests.every((request) =>
          ["status", "questions", "events"].includes(request.operation),
        ),
      );
    },
  );
});

await test("CLV-093 CLI reads the service origin from a relative repository path", async () => {
  const replies = watchReplies({ runs: [stoppedPrRun()] });
  await withWatchService(
    {
      answer: replies.answer,
      configure: async (runtime) => {
        const options = await configuredPrWatch(runtime);
        return {
          ...options,
          environment: {
            ...options.environment,
            CLOVING_WATCH_REPOSITORY: "./service-repository",
          },
        };
      },
    },
    async (watch, runtime) => {
      await recordedPrJournal(runtime);
      const first = stoppedPrCard(await watchData(watch.address));
      assert.deepEqual(first["pullRequestObservation"], { status: "pending" });
      assert.deepEqual(await ghRequest(runtime), [
        "prefix with spaces",
        "api",
        "--method",
        "GET",
        "--hostname",
        "github.example",
        "repos/fixture/demo/pulls/7",
        "--include",
      ]);
      await releasePr(runtime, true);
      await waitForPrObservation(watch, { status: "merged" });
    },
  );
});
