import assert from "node:assert/strict";
import { test } from "node:test";
import { serviceLimits } from "../src/service/service.ts";
import { effectScene } from "./service-effect-fixture.ts";
import {
  call,
  digestOf,
  withHarness,
  type Harness,
} from "./service-fixture.ts";
import { writeDeclaredWorkflow } from "./workflow-folder-fixture.ts";
import { reportTurn, workerScene } from "./worker-report-fixture.ts";

function effectResult(
  harness: Harness,
  parameters: Readonly<Record<string, unknown>>,
) {
  return call(harness, { operation: "effect-result", parameters });
}

await test("CLV-351 the service gives the stored result that an effect report of the run names", () =>
  withHarness(async (harness) => {
    const scene = await workerScene(harness);
    const body = JSON.stringify({ number: 8, score: 5 });
    await reportTurn(scene, { round: 1, result: body });
    assert.deepEqual(
      await effectResult(harness, {
        runId: scene.runId,
        digest: digestOf(body),
      }),
      {
        schemaVersion: 1,
        kind: "effect-result",
        runId: scene.runId,
        digest: digestOf(body),
        result: body,
      },
    );
  }));

await test("CLV-351 the service refuses a digest that no effect report of the run names", () =>
  withHarness(async (harness) => {
    const scene = await workerScene(harness);
    const body = JSON.stringify({ number: 8, score: 5 });
    await reportTurn(scene, { round: 1, result: body });
    for (const parameters of [
      { runId: scene.runId, digest: digestOf("build the package") },
      { runId: scene.runId, digest: digestOf("no document") },
      { runId: "run-other", digest: digestOf(body) },
    ]) {
      const reply = await effectResult(harness, parameters);
      assert.equal(reply["kind"], "error");
      assert.equal(reply["code"], "unknown-effect-result");
      assert.equal(reply["result"], undefined);
    }
  }));

await test("CLV-351 the service refuses an effect result read with invalid parameters", () =>
  withHarness(async (harness) => {
    const scene = await workerScene(harness);
    for (const parameters of [
      {},
      { runId: scene.runId },
      { runId: scene.runId, digest: "sha256:abc" },
      { runId: 7, digest: digestOf("x") },
    ]) {
      const reply = await effectResult(harness, parameters);
      assert.equal(reply["code"], "invalid-request");
    }
  }));

await test("CLV-351 the service refuses a stored effect result over 64 KiB", () =>
  withHarness(async (harness) => {
    const declaration = await writeDeclaredWorkflow(harness.projectDirectory);
    const scene = await effectScene(harness, {
      effectLimit: 20,
      workflowId: declaration.workflow.workflowId,
      capabilities: ["claude", "fake-harness"],
      limits: { ...serviceLimits, textBytes: 131_072 },
    });
    const limit = JSON.stringify({ text: "a".repeat(65_536 - 11) });
    const large = JSON.stringify({ text: "é".repeat(32_768) });
    await reportTurn(scene, { round: 1, result: limit });
    await reportTurn(scene, { round: 2, result: large });
    assert.equal(
      (
        await effectResult(harness, {
          runId: scene.runId,
          digest: digestOf(limit),
        })
      )["result"],
      limit,
    );
    const reply = await effectResult(harness, {
      runId: scene.runId,
      digest: digestOf(large),
    });
    assert.equal(reply["code"], "effect-result-too-large");
    assert.match(String(reply["detail"]), /65547 bytes.*65536/);
  }));
