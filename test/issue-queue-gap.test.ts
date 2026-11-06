import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Fields, Reply } from "../src/protocol.ts";
import { restartText } from "../src/restart-request.ts";
import type { Handle } from "../src/service/transport.ts";
import { eventually } from "./service-fixture.ts";
import { withQueue } from "./issue-queue-fixture.ts";

const reply = (fields: Fields): Promise<Reply> =>
  Promise.resolve({ kind: "result", result: fields });

await test("CLV-306 a drain ends only at a gap, so a run of a workflow outside the queue keeps it draining", async () => {
  const scene = { state: "running", admissions: 0 };
  await withQueue(
    {
      handle: (request) => {
        if (request.operation === "run") scene.admissions += 1;
        return reply({
          queue: { workflowId: "develop", busy: 0 },
          runs: [{ workflowId: "review-corpus", state: scene.state }],
          next: null,
        });
      },
      drain: { startedAt: 1, drainedAt: null },
    },
    async ({ control }) => {
      await delay(200);
      assert.equal(control()?.drain?.drainedAt, null);
      scene.state = "completed";
      await eventually(() =>
        typeof control()?.drain?.drainedAt === "number" ? true : undefined,
      );
      assert.equal(scene.admissions, 0);
    },
  );
});

function idleService(scene: { admissions: number }): Handle {
  return (request) => {
    if (request.operation !== "run")
      return reply({
        queue: { workflowId: "develop", busy: 0 },
        runs: [],
        next: null,
      });
    scene.admissions += 1;
    return Promise.resolve({
      kind: "error",
      error: { code: "no-ready-ticket", detail: "empty" },
    });
  };
}

await test("CLV-306 the queue admits no new run while a restart is pending", async () => {
  const scene = { admissions: 0 };
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    lines.push(String(chunk));
    return true;
  };
  try {
    await withQueue(
      {
        handle: idleService(scene),
        pendingRestart: restartText({
          at: "gap",
          requestedAt: Date.now(),
          commandId: "restart-one",
          resumeQueue: false,
        }),
      },
      async ({ directory }) => {
        await delay(200);
        assert.equal(scene.admissions, 0);
        await rm(join(directory, "pending-restart"));
        await eventually(() => (scene.admissions > 0 ? true : undefined));
      },
    );
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(
    lines.filter((line) => line.includes("restart")),
    ["Queue holding for pending restart\n"],
  );
});

await test("CLV-306 a start after a restart with --resume-queue clears the drain and keeps the failure count", async () => {
  await withQueue(
    {
      handle: idleService({ admissions: 0 }),
      drain: { startedAt: 1, drainedAt: 2 },
      failures: ["run-a", "run-b"],
      resumeQueue: true,
    },
    async ({ control, directory }) => {
      await eventually(() =>
        control() !== undefined && control()?.drain === undefined
          ? true
          : undefined,
      );
      assert.deepEqual(control()?.failedRunIds, ["run-a", "run-b"]);
      assert.equal(existsSync(join(directory, "resume-queue")), false);
    },
  );
});

await test("CLV-306 a start without --resume-queue keeps the drain and the failure count", async () => {
  await withQueue(
    {
      handle: idleService({ admissions: 0 }),
      drain: { startedAt: 1, drainedAt: 2 },
      failures: ["run-a"],
    },
    async ({ control }) => {
      await eventually(() => (control() === undefined ? undefined : true));
      await delay(100);
      assert.deepEqual(control()?.drain, { startedAt: 1, drainedAt: 2 });
      assert.deepEqual(control()?.failedRunIds, ["run-a"]);
    },
  );
});
