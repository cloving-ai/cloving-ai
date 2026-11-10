import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { channelAlerts } from "../src/cli/mcp-channel.ts";
import type { Fields } from "../src/protocol.ts";
import { withNotificationEnvironment } from "./notify-check-fixture.ts";
import { channelService } from "./mcp-channel-fixture.ts";
import { eventually, fields, withHarness } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const timing = {
  retryMilliseconds: 20,
  scheduleMilliseconds: 30,
  burstMilliseconds: 10,
};

const failedRun = {
  runId: "run-failed0000",
  workflowId: "develop",
  state: "failed",
  reason: { code: "turn-failed", detail: "The turn failed." },
};

function watching(runtimeDirectory: string) {
  const messages: Fields[] = [];
  const watcher = channelAlerts({
    runtimeDirectory,
    privateTexts: [],
    timing,
    write: (message) => {
      messages.push(fields(message["params"]));
      return Promise.resolve();
    },
  });
  return { messages, stop: () => watcher.stop() };
}

function kinds(messages: readonly Fields[]): readonly string[] {
  return messages.map((message) => String(fields(message["meta"])["kind"]));
}

await test("CLV-338 the channel reads stopped schedules on its own interval", () =>
  withHarness(async (harness) => {
    const service = await channelService(harness.runtimeDirectory);
    harness.cleanup(() => service.close());
    const watch = watching(harness.runtimeDirectory);
    harness.cleanup(() => watch.stop());
    await delay(testMilliseconds(100));
    service.stopped({
      workflowId: "patrol",
      stops: [
        {
          stoppedAt: 900_000,
          stoppedSlot: 4,
          failedRunIds: ["run-one", "run-two", "run-three"],
        },
      ],
    });
    await eventually(() => (watch.messages.length > 0 ? true : undefined));
    await watch.stop();
    assert.deepEqual(kinds(watch.messages), ["schedule_stopped"]);
  }));

await test("CLV-338 the channel waits for the service, then sends the open items", () =>
  withHarness(async (harness) => {
    const watch = watching(harness.runtimeDirectory);
    harness.cleanup(() => watch.stop());
    await delay(testMilliseconds(100));
    const service = await channelService(harness.runtimeDirectory);
    harness.cleanup(() => service.close());
    service.run(failedRun, "run.failed");
    await eventually(() => (watch.messages.length > 0 ? true : undefined));
    await service.close();
    await delay(testMilliseconds(100));
    const again = await channelService(harness.runtimeDirectory);
    harness.cleanup(() => again.close());
    again.run(failedRun, "run.failed");
    again.run({ ...failedRun, runId: "run-second000" }, "run.failed");
    await eventually(() => (watch.messages.length > 1 ? true : undefined));
    await watch.stop();
    assert.deepEqual(kinds(watch.messages), ["failed", "failed"]);
  }));

for (const journal of [
  "not json",
  '{"version": 2, "entries": []}',
  '{"version": 1, "entries": [{"key": 1, "runId": "run"}]}',
])
  await test(`CLV-338 the channel reports the journal ${journal} and sends nothing`, () =>
    withNotificationEnvironment((environment) =>
      withHarness(async (harness) => {
        await writeFile(
          join(harness.runtimeDirectory, "channel-events.json"),
          journal,
        );
        const service = await channelService(harness.runtimeDirectory);
        harness.cleanup(() => service.close());
        service.run(failedRun, "run.failed");
        const watch = watching(harness.runtimeDirectory);
        harness.cleanup(() => watch.stop());
        await eventually(() =>
          environment.errors.some((line) =>
            line.includes('Channel read failed: "invalid-channel-record"'),
          )
            ? true
            : undefined,
        );
        await watch.stop();
        assert.deepEqual(watch.messages, []);
      }),
    ));

await test("CLV-338 the channel skips a run that the service no longer knows and reports a failed read", () =>
  withNotificationEnvironment((environment) =>
    withHarness(async (harness) => {
      const service = await channelService(harness.runtimeDirectory);
      harness.cleanup(() => service.close());
      const watch = watching(harness.runtimeDirectory);
      harness.cleanup(() => watch.stop());
      await delay(testMilliseconds(100));
      service.run({ ...failedRun, runId: "run-removed00" }, "run.failed");
      service.state.runs.delete("run-removed00");
      service.state.failing.add("run-broken000");
      service.run({ ...failedRun, runId: "run-broken000" }, "run.failed");
      await eventually(() =>
        environment.errors.some((line) =>
          line.includes('Channel read failed: "authority-unavailable"'),
        )
          ? true
          : undefined,
      );
      service.run(failedRun, "run.failed");
      await eventually(() => (watch.messages.length > 0 ? true : undefined));
      await watch.stop();
      assert.deepEqual(
        watch.messages.map((message) => fields(message["meta"])["run_id"]),
        [failedRun.runId],
      );
    }),
  ));

await test("CLV-338 the channel reads the other runs of a burst after a failed read and retries the failed run with no new event", () =>
  withNotificationEnvironment((environment) =>
    withHarness(async (harness) => {
      const service = await channelService(harness.runtimeDirectory);
      harness.cleanup(() => service.close());
      const watch = watching(harness.runtimeDirectory);
      harness.cleanup(() => watch.stop());
      await delay(testMilliseconds(100));
      const broken = { ...failedRun, runId: "run-broken000" };
      service.state.failing.add(broken.runId);
      service.run(broken, "run.failed");
      service.run(failedRun, "run.failed");
      await eventually(() => (watch.messages.length > 0 ? true : undefined));
      assert.ok(
        environment.errors.some((line) =>
          line.includes('Channel read failed: "authority-unavailable"'),
        ),
      );
      service.state.failing.delete(broken.runId);
      await eventually(() => (watch.messages.length > 1 ? true : undefined));
      await watch.stop();
      assert.deepEqual(
        watch.messages.map((message) => fields(message["meta"])["run_id"]),
        [failedRun.runId, broken.runId],
      );
    }),
  ));

await test("CLV-338 the channel reads a run one time for a burst of its events", () =>
  withHarness(async (harness) => {
    const service = await channelService(harness.runtimeDirectory);
    harness.cleanup(() => service.close());
    const messages: Fields[] = [];
    const watcher = channelAlerts({
      runtimeDirectory: harness.runtimeDirectory,
      privateTexts: [],
      timing: { ...timing, burstMilliseconds: 1000 },
      write: (message) => {
        messages.push(message);
        return Promise.resolve();
      },
    });
    harness.cleanup(() => watcher.stop());
    await delay(testMilliseconds(100));
    for (let index = 0; index < 10; index += 1) {
      service.run(failedRun, "run.observed");
      await delay(10);
    }
    await eventually(() => (messages.length > 0 ? true : undefined));
    await watcher.stop();
    const reads = service.state.requests.filter(
      (request) =>
        request["operation"] === "status" &&
        request["runId"] === failedRun.runId,
    );
    assert.equal(reads.length, 1);
  }));
