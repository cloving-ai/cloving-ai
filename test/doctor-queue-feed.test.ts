import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkflowDeclaration } from "../src/workflow-declaration.ts";
import { check, withDoctor } from "./doctor-fixture.ts";
import { writeQueueWorkflow } from "./workflow-folder-fixture.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";

async function writeWorkflow(input: {
  readonly folder: string;
  readonly name: string;
  readonly queue?: WorkflowDeclaration["queue"];
}): Promise<void> {
  await mkdir(input.folder, { recursive: true });
  await writeFile(
    join(input.folder, `${input.name}.ts`),
    'throw new Error("doctor must not execute workflow code")',
  );
  await writeFile(
    join(input.folder, `${input.name}.declaration.json`),
    JSON.stringify({
      ...candidateDeclaration,
      workflow: {
        ...candidateDeclaration.workflow,
        workflowId: input.name,
        queue: input.queue,
        input: { maximumBytes: 4096, fields: { ticket: { type: "ticket" } } },
      },
    }),
  );
}

await test("CLV-362 doctor names a queue using ticket commands and recommends a feed", () =>
  withDoctor(async (scene) => {
    await writeQueueWorkflow(join(scene.repository, ".cloving/workflows"));
    const output = await scene.report();
    assert.deepEqual(check(output, "queue-feed"), {
      code: "queue-feed",
      result: "warn",
      required: false,
      detail: "Queues without a feed: queued",
      fix: "Add a feed function to the queue declaration",
    });
    assert.equal(check(output, "next-command")["required"], true);
    assert.equal(check(output, "ticket-command")["required"], true);
    assert.equal(output.status, 0);
  }));

await test("CLV-362 doctor lists every project and user queue without a feed in workflow ID order", () =>
  withDoctor(async (scene) => {
    const folder = join(scene.repository, ".cloving/workflows");
    await writeWorkflow({ folder, name: "zeta", queue: true });
    await writeWorkflow({ folder, name: "alpha", queue: {} });
    await writeWorkflow({ folder, name: "fed", queue: { feed: "triageFeed" } });
    await writeWorkflow({ folder, name: "manual", queue: false });
    await writeWorkflow({
      folder: join(scene.root, "config/cloving/workflows"),
      name: "beta",
      queue: { lanes: 2 },
    });
    const output = await scene.report();
    assert.equal(check(output, "queue-feed")["result"], "warn");
    assert.equal(
      check(output, "queue-feed")["detail"],
      "Queues without a feed: alpha, beta, zeta",
    );
    assert.equal(output.status, 0);
  }));

for (const queue of [undefined, false, { feed: "triageFeed" }])
  await test(`CLV-362 doctor accepts a workflow with queue ${JSON.stringify(queue)}`, () =>
    withDoctor(async (scene) => {
      await writeWorkflow({
        folder: join(scene.repository, ".cloving/workflows"),
        name: "triage",
        queue,
      });
      const output = await scene.report();
      assert.equal(check(output, "queue-feed")["result"], "ok");
      assert.equal(check(output, "queue-feed")["required"], false);
      assert.equal(
        check(output, "queue-feed")["detail"],
        queue === undefined || queue === false
          ? "No declared queues"
          : "All declared queues have a feed",
      );
      assert.equal(output.status, 0);
    }));

await test("CLV-362 doctor still recommends a feed for a disabled legacy queue", () =>
  withDoctor(async (scene) => {
    await writeQueueWorkflow(join(scene.repository, ".cloving/workflows"));
    const output = await scene.report({
      CLOVING_QUEUES: '{"queued":{"state":"off"}}',
      CLOVING_NEXT_COMMAND: undefined,
    });
    assert.equal(check(output, "queue-feed")["result"], "warn");
    assert.equal(
      check(output, "queue-feed")["detail"],
      "Queues without a feed: queued",
    );
    assert.equal(check(output, "next-command")["required"], false);
    assert.equal(output.status, 0);
  }));
