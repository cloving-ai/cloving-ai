import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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

await test("#831 doctor does not require a next command for a copied develop template", () =>
  withDoctor(async (scene) => {
    const copied = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), "templates", "copy", "develop"],
      { cwd: scene.repository, env: scene.environment, encoding: "utf8" },
    );
    assert.equal(copied.status, 0, copied.stdout + copied.stderr);
    const configured = await scene.report({ CLOVING_QUEUE_SECONDS: undefined });
    assert.equal(check(configured, "next-command")["result"], "ok");
    assert.match(
      String(check(configured, "next-command")["detail"]),
      /^\[".+"\] from /,
    );
    const unset = {
      CLOVING_NEXT_COMMAND: undefined,
      CLOVING_QUEUE_SECONDS: undefined,
    };
    const output = await scene.report(unset);
    assert.deepEqual(check(output, "next-command"), {
      code: "next-command",
      result: "ok",
      required: false,
      detail:
        "The feed of the queue selects the tickets: develop (developFeed)",
      fix: "Set tickets.nextCommand to an executable list: ${EDITOR:-vi} .cloving/config.json",
    });
    assert.equal(check(output, "queue-interval")["required"], true);
    assert.equal(output.status, 0);
    await writeWorkflow({
      folder: join(scene.repository, ".cloving/workflows"),
      name: "legacy",
      queue: true,
    });
    const legacy = await scene.report(unset);
    assert.equal(check(legacy, "next-command")["result"], "fail");
    assert.equal(check(legacy, "next-command")["required"], true);
    assert.equal(legacy.status, 1);
    const off = await scene.report({
      ...unset,
      CLOVING_QUEUES: '{"legacy":{"state":"off"}}',
    });
    assert.equal(check(off, "next-command")["result"], "ok");
    assert.equal(check(off, "next-command")["required"], false);
    assert.equal(off.status, 0);
  }));

await test("#831 the README states when the next-command check names a feed", async () => {
  const readme = await readFile("README.md", "utf8");
  assert.match(
    readme,
    /For each declared queue, `cloving doctor` requires `queue-interval`\. It requires `next-command` only for a queue without a feed whose state in the `queues` setting is not `off`\./,
  );
  assert.match(
    readme,
    /When no queue requires `next-command` and `tickets\.nextCommand` is not set, the `next-command` check reports one of these results:\n\n- `ok` when at least one queue with a feed is not `off`\. The check names each feed that selects the tickets, for example `The feed of the queue selects the tickets: develop \(developFeed\)`\.\n- `fail` in all other cases\. This failure is not required, so it does not change the exit status\.\n/,
  );
  assert.match(
    readme,
    /`cloving doctor` does not require `next-command` for this queue\./,
  );
  assert.doesNotMatch(readme, /requires `next-command` and `queue-interval`/);
});
