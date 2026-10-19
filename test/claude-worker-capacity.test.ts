import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  field,
  intent,
  journalKey,
  record,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

const signal = new AbortController().signal;
const continuation =
  "An earlier attempt stopped because the model was at capacity; continue from the current state of the work tree.\n\n";

function recordedAttempts(folder: string): void {
  const activity = readFileSync(join(folder, "turn.jsonl"), "utf8");
  assert.equal(activity.match(/"type":"system"/g)?.length, 2);
  assert.equal(activity.match(/"type":"result"/g)?.length, 2);
  assert.match(activity, /Selected model is at capacity/);
  assert.match(activity, /An earlier attempt stopped/);
  const attempts = readdirSync(folder).filter((name) =>
    /^attempt-\d+\.json$/.test(name),
  );
  assert.deepEqual(attempts, ["attempt-1.json", "attempt-2.json"]);
  for (const name of attempts) {
    const path = join(folder, name);
    const attempt: unknown = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(typeof field(attempt, "startedAt"), "string");
    assert.equal(typeof field(attempt, "endedAt"), "string");
    assert.equal(field(attempt, "operationId"), "operation-1");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
}

await test("CLV-127 capacity then success completes one operation with retained work and summed usage", () =>
  withScene(async (scene) => {
    const waits: number[] = [];
    const worker = scene.worker("capacity-once", {
      profiles: {
        checker: {
          model: "sonnet",
          maxBudgetUsd: 7,
          allowedTools: ["Read"],
          env: { ANTHROPIC_BASE_URL: "https://capacity.invalid/{turn}" },
        },
      },
      retryDelay: (milliseconds, waiting) => {
        waits.push(milliseconds);
        return delay(0, undefined, { signal: waiting });
      },
    });
    const operation = intent({ method: "run-turn:checker" });
    await worker.deliver(operation, signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.deepEqual(waits, [60_000]);
    const [first, second] = scene.turns();
    assert.equal(scene.turns().length, 2);
    assert.ok(first);
    assert.ok(second);
    assert.equal(second.directory, first.directory);
    assert.equal(second.prompt, continuation + first.prompt);
    assert.ok(second.files.includes("partial.txt"));
    assert.deepEqual(second.arguments, first.arguments);
    assert.deepEqual(second.environment, first.environment);
    const result = resultOf(scene.reports[0].result);
    assert.deepEqual(result["usage"], {
      input_tokens: 3000,
      cache_read_input_tokens: 1600,
      output_tokens: 300,
    });
    assert.equal(result["costUsd"], 0.5);
    assert.equal(result["turns"], 6);
    const folder = join(scene.journal, journalKey("operation-1"));
    recordedAttempts(folder);
    assert.deepEqual(await worker.deliver(operation, signal), {
      kind: "completed",
      receipt: journalKey("operation-1"),
      worker: "claude",
      result: scene.reports[0].result,
    });
    assert.equal(scene.turns().length, 2);
  }));

await test("CLV-127 the Claude assistant overload type survives the final result and retries", () =>
  withScene(async (scene) => {
    const worker = scene.worker("overload-once", {
      retryDelay: (_, waiting) => delay(0, undefined, { signal: waiting }),
    });
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(scene.turns().length, 2);
  }));

await test("CLV-127 the shared activity stream includes a retry while it is running", () =>
  withScene(async (scene) => {
    const worker = scene.worker("capacity-hold", {
      retryDelay: () => Promise.resolve(),
    });
    await worker.deliver(intent(), signal);
    await until(() => scene.turns().length === 2);
    const file = join(scene.journal, journalKey("operation-1"), "turn.jsonl");
    await until(
      () => readFileSync(file, "utf8").match(/"type":"system"/g)?.length === 2,
    );
    assert.equal(scene.reports.length, 0);
    assert.equal(
      field(record(scene, "operation-1/started.json"), "phase"),
      "running",
    );
    assert.equal((await worker.stop(intent(), signal)).kind, "stopped");
    assert.equal(scene.reports.length, 1);
    assert.equal(scene.turns().length, 2);
  }));

await test("CLV-127 three capacity refusals exhaust waits of 60 and 180 seconds", () =>
  withScene(async (scene) => {
    const waits: number[] = [];
    const worker = scene.worker("capacity-always", {
      retryDelay: (milliseconds, waiting) => {
        waits.push(milliseconds);
        return delay(0, undefined, { signal: waiting });
      },
    });
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.turns().length, 3);
    assert.deepEqual(waits, [60_000, 180_000]);
    assert.equal(scene.reports[0]?.reason, "claude-turn-failed");
    assert.equal(resultOf(scene.reports[0].result)["costUsd"], 0.75);
    assert.deepEqual(resultOf(scene.reports[0].result)["usage"], {
      input_tokens: 4500,
      cache_read_input_tokens: 2400,
      output_tokens: 450,
    });
    assert.equal(
      typeof field(record(scene, "operation-1/attempt-3.json"), "endedAt"),
      "string",
    );
  }));

await test("CLV-127 the first start time survives both waits and every attempt", () =>
  withScene(async (scene) => {
    const waits: unknown[] = [];
    const resumedAt: number[] = [];
    const worker = scene.worker("capacity-always", {
      retryDelay: async () => {
        waits.push(record(scene, "operation-1/started.json"));
        const previous = record(
          scene,
          `operation-1/attempt-${String(waits.length)}.json`,
        );
        const previousStart = field(previous, "startedAt");
        assert.ok(typeof previousStart === "string");
        await until(() => Date.now() > Date.parse(previousStart));
        resumedAt.push(Date.now());
      },
    });
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    const first = field(
      record(scene, "operation-1/attempt-1.json"),
      "startedAt",
    );
    assert.ok(typeof first === "string");
    assert.equal(waits.length, 2);
    for (const waiting of waits) {
      assert.equal(field(waiting, "phase"), "waiting");
      assert.equal(field(waiting, "startedAt"), first);
    }
    assert.equal(
      field(record(scene, "operation-1/started.json"), "startedAt"),
      first,
    );
    for (const [index, resumed] of resumedAt.entries()) {
      const attempt = record(
        scene,
        `operation-1/attempt-${String(index + 2)}.json`,
      );
      const startedAt = field(attempt, "startedAt");
      assert.ok(typeof startedAt === "string");
      assert.ok(Date.parse(startedAt) >= resumed);
      assert.ok(Date.parse(startedAt) > Date.parse(first));
    }
    const endedAt = field(record(scene, "operation-1/result.json"), "endedAt");
    assert.ok(typeof endedAt === "string");
    assert.ok(Date.parse(endedAt) > Date.parse(first));
  }));

await test("CLV-127 a non-capacity failure journals one attempt and never waits", () =>
  withScene(async (scene) => {
    const worker = scene.worker("error-result", {
      retryDelay: () => {
        throw new Error("unexpected-capacity-retry");
      },
    });
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.reason, "claude-turn-failed");
    assert.equal(scene.turns().length, 1);
    assert.equal(
      typeof field(record(scene, "operation-1/attempt-1.json"), "endedAt"),
      "string",
    );
    assert.equal(record(scene, "operation-1/attempt-2.json"), undefined);
  }));

await test("CLV-127 stop during a capacity wait reports stopped without a second launch", () =>
  withScene(async (scene) => {
    let waiting = false;
    const worker = scene.worker("capacity-always", {
      retryDelay: (milliseconds, stopping) => {
        waiting = true;
        return delay(milliseconds, undefined, { signal: stopping });
      },
    });
    await worker.deliver(intent(), signal);
    await until(() => waiting || scene.reports.length > 0);
    assert.equal(waiting, true);
    assert.equal(
      field(record(scene, "operation-1/started.json"), "phase"),
      "waiting",
    );
    assert.equal(
      field(await worker.deliver(intent(), signal), "kind"),
      "accepted",
    );
    const stopped = await worker.stop(intent(), signal);
    assert.equal(stopped.kind, "stopped");
    assert.equal(scene.reports[0]?.outcome, "stopped");
    assert.equal(scene.turns().length, 1);
    assert.equal(scene.reports.length, 1);
  }));
