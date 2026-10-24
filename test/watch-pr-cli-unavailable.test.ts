import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { alive, until } from "./claude-worker-fixture.ts";
import { fields, withHarness } from "./service-fixture.ts";
import {
  configuredPrWatch,
  directPrWatch,
  ghRequest,
  recordedPrJournal,
  stoppedPrCard,
  stoppedPrRun,
} from "./watch-pr-cli-fixture.ts";
import {
  watchData,
  watchReplies,
  withWatchService,
} from "./watch-service-fixture.ts";

await test("CLV-093 request readiness waits for a fully written process ID", async () => {
  await withHarness(async (harness) => {
    const root = dirname(harness.runtimeDirectory);
    await writeFile(join(root, "gh-request"), "[]");
    await writeFile(join(root, "gh-pid"), "");
    let ready = false;
    const request = ghRequest(harness.runtimeDirectory).then((value) => {
      ready = true;
      return value;
    });
    try {
      await delay(50);
      assert.equal(ready, false);
    } finally {
      await writeFile(join(root, "gh-pid"), String(process.pid));
      await request;
    }
    assert.deepEqual(await request, []);
  });
});

await test("CLV-093 direct watch server without PR settings retains local data and reports configuration status", async () => {
  const replies = watchReplies({ runs: [stoppedPrRun()] });
  await withWatchService(
    { answer: replies.answer, launch: directPrWatch },
    async (watch, runtime) => {
      await recordedPrJournal(runtime);
      const model = await watchData(watch.address);
      assert.equal(model["service"], "up");
      const card = stoppedPrCard(model);
      assert.equal(fields(card["completionMark"])["text"], "Needs attention");
      assert.deepEqual(card["pullRequestObservation"], {
        status: "unavailable",
        failure: "configuration",
      });
    },
  );
});

for (const [failure, environment] of [
  ["configuration", { CLOVING_WATCH_REPOSITORY: "" }],
  ["configuration", { CLOVING_GH_COMMAND: "not-json" }],
  ["command", { CLOVING_GH_COMMAND: '["missing-cloving-test-gh-command"]' }],
] as const)
  await test(`CLV-093 CLI refuses unavailable settings and tooling ${JSON.stringify(environment)}`, async () => {
    const replies = watchReplies({ runs: [stoppedPrRun()] });
    const configure = async (runtime: string) => {
      const options = await configuredPrWatch(runtime);
      return {
        ...options,
        environment: { ...options.environment, ...environment },
      };
    };
    await withWatchService(
      { answer: replies.answer, configure },
      async (watch, runtime) => {
        await recordedPrJournal(runtime);
        await until(
          async () =>
            fields(
              stoppedPrCard(await watchData(watch.address))[
                "pullRequestObservation"
              ],
            )["status"] === "unavailable",
        );
        const model = await watchData(watch.address);
        assert.equal(model["service"], "up");
        assert.deepEqual(stoppedPrCard(model)["pullRequestObservation"], {
          status: "unavailable",
          failure,
        });
        await assert.rejects(readFile(join(dirname(runtime), "gh-request")), {
          code: "ENOENT",
        });
      },
    );
  });

await test("CLV-093 CLI terminates a held GitHub command after five seconds", async () => {
  const replies = watchReplies({ runs: [stoppedPrRun()] });
  await withWatchService(
    { answer: replies.answer, configure: configuredPrWatch },
    async (watch, runtime) => {
      await recordedPrJournal(runtime);
      const first = await watchData(watch.address);
      assert.deepEqual(stoppedPrCard(first)["pullRequestObservation"], {
        status: "pending",
      });
      await ghRequest(runtime);
      const pid = Number(
        await readFile(join(dirname(runtime), "gh-pid"), "utf8"),
      );
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      await until(
        async () =>
          fields(
            stoppedPrCard(await watchData(watch.address))[
              "pullRequestObservation"
            ],
          )["failure"] === "timeout",
      );
      const model = await watchData(watch.address);
      assert.equal(model["service"], "up");
      assert.deepEqual(stoppedPrCard(model)["pullRequestObservation"], {
        status: "unavailable",
        failure: "timeout",
      });
      await until(() => !alive(pid));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    },
  );
});
