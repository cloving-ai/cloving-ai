import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { queueJournal } from "../src/daemon/queue-journal.ts";
import { eventually } from "./service-fixture.ts";
import { withQueue } from "./issue-queue-fixture.ts";

await test("CLV-373 a v1.9 drain in migrated storage waits for unrelated workflow work", async () => {
  const scene = { active: true, checks: 0, admissions: 0 };
  await withQueue(
    {
      storage: "workflow",
      drain: { startedAt: 1, drainedAt: null },
      handle: (request) => {
        if (request.operation === "run") scene.admissions += 1;
        scene.checks += 1;
        return Promise.resolve({
          kind: "result",
          result: {
            queue: { workflowId: "develop", busy: 0 },
            runs: scene.active
              ? [{ workflowId: "review-corpus", state: "running" }]
              : [],
            next: null,
          },
        });
      },
    },
    async ({ control }) => {
      await eventually(() => (scene.checks >= 4 ? true : undefined));
      assert.equal(control()?.drain?.drainedAt, null);
      scene.active = false;
      await eventually(() => control()?.drain?.drainedAt ?? undefined);
      assert.equal(scene.admissions, 0);
    },
  );
});

await test("CLV-373 an explicit workflow drain keeps its scope through journal recovery", async () => {
  await withQueue(
    {
      storage: "workflow",
      drain: { startedAt: 1, drainedAt: null, scope: "workflow" },
      handle: () =>
        Promise.resolve({
          kind: "result",
          result: {
            queue: { workflowId: "develop", busy: 0 },
            runs: [{ workflowId: "review-corpus", state: "running" }],
            next: null,
          },
        }),
    },
    async ({ control, directory, stop }) => {
      await eventually(() => control()?.drain?.drainedAt ?? undefined);
      await stop();
      const recovered = await queueJournal(
        join(directory, "queues", "develop"),
      );
      assert.deepEqual(recovered.drain, {
        ...control()?.drain,
        scope: "workflow",
      });
    },
  );
});
