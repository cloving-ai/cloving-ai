import assert from "node:assert/strict";
import { test } from "node:test";
import { operationOf } from "./effect-fixture.ts";
import {
  call,
  field,
  items,
  parsed,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

async function submit(harness: Harness, commandId: string) {
  const reply = await call(harness, {
    operation: "run",
    parameters: {
      workflowId: "develop",
      source: "input",
      submission: { prompt: "next" },
      commandId,
    },
  });
  return String(reply["runId"]);
}

await test("CLV-183 status text and JSON link parents and every child, including across list pages", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const root = await submit(harness, "status-root");
    const children = [];
    for (const round of [1, 2])
      children.push(
        await submit(harness, `handoff:${operationOf(root, { round })}`),
      );
    const child = children[0];
    assert.ok(child);
    for (const [runId, parentRunId, childRunIds] of [
      [root, null, children],
      [child, root, []],
    ] as const) {
      const json = await harness.cli(["status", runId, "--json"]);
      assert.equal(json.status, 0, json.stderr);
      const run = parsed(json)["run"];
      assert.equal(field(run, "parentRunId"), parentRunId);
      assert.equal(field(run, "chainId"), root);
      assert.deepEqual(field(run, "childRunIds"), childRunIds);
      const plain = await harness.cli(["status", runId]);
      assert.equal(plain.status, 0, plain.stderr);
      assert.ok(
        plain.stdout.includes(`Parent run: ${parentRunId ?? "none"}\n`),
      );
      assert.ok(plain.stdout.includes(`Chain: ${root}\n`));
      assert.ok(
        plain.stdout.includes(
          `Child runs: ${childRunIds.length === 0 ? "none" : childRunIds.join(", ")}\n`,
        ),
      );
    }
    const listed = await harness.cli(["status", "--json", "--limit", "1"]);
    assert.equal(listed.status, 0, listed.stderr);
    const run = items(parsed(listed)["runs"])[0];
    assert.equal(field(run, "chainId"), root);
    assert.ok([root, ...children].includes(String(field(run, "runId"))));
    const text = await harness.cli(["status"]);
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.includes(`Parent run: ${root}`));
    assert.ok(text.stdout.includes(`Child runs: ${children.join(", ")}`));
    await service.close();
  }));
