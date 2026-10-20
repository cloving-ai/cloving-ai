import assert from "node:assert/strict";
import { test } from "node:test";
import { until } from "./claude-worker-fixture.ts";
import { fields, items } from "./service-fixture.ts";
import {
  configuredPrWatch,
  recordedPrJournal,
  releasePrOutput,
  stoppedPrCard,
  stoppedPrRun,
} from "./watch-pr-cli-fixture.ts";
import { prOutput } from "./watch-pr-fixture.ts";
import {
  watchData,
  watchReplies,
  withWatchService,
} from "./watch-service-fixture.ts";

for (const [failure, output] of [
  ["command", { status: 1, stderr: "raw command secret" }],
  ["access", { status: 4, stderr: "raw auth secret" }],
  ["access", { status: 1, stderr: "raw permission secret (HTTP 403)" }],
  ["access", { status: 1, stderr: "raw missing secret (HTTP 404)" }],
  ["rate-limit", { status: 1, stderr: "raw rate limit secret (HTTP 429)" }],
  ["response", { stdout: "raw malformed secret" }],
  ["response", { stdout: prOutput(null).stdout }],
  ["identity", { stdout: prOutput(true, 8).stdout }],
] as const)
  await test(`CLV-093 CLI ${failure} read failure keeps local data and hides upstream text ${JSON.stringify(output)}`, async () => {
    const replies = watchReplies({ runs: [stoppedPrRun()] });
    await withWatchService(
      { answer: replies.answer, configure: configuredPrWatch },
      async (watch, runtime) => {
        await recordedPrJournal(runtime);
        await releasePrOutput(runtime, { ...prOutput(true), ...output });
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
        const observation = fields(
          stoppedPrCard(model)["pullRequestObservation"],
        );
        assert.equal(observation["status"], "unavailable");
        assert.equal(observation["failure"], failure);
        const retryAt = observation["retryAt"];
        assert.deepEqual(observation, {
          status: "unavailable",
          failure,
          ...(failure === "rate-limit" ? { retryAt } : {}),
        });
        assert.equal(typeof (retryAt ?? 0), "number");
        assert.ok(failure !== "rate-limit" || Number(retryAt) > Date.now());
        assert.equal(fields(items(model["runs"])[0])["outcome"], "blocked");
        assert.doesNotMatch(JSON.stringify(model), /raw |secret/);
      },
    );
  });
