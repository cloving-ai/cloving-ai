import assert from "node:assert/strict";
import { after, test } from "node:test";
import { record } from "../src/protocol.ts";
import { removeTemporaryDirectories } from "./authority-store-fixture.ts";
import { call, fields, items } from "./service-fixture.ts";
import { withQueueSpend } from "./queue-spend-fixture.ts";

after(removeTemporaryDirectories);

type Scene = Parameters<Parameters<typeof withQueueSpend>[0]>[0];

async function endedRun(scene: Scene, name: string): Promise<string> {
  const runId = await scene.begin(name);
  const shown = await call(scene.harness, {
    operation: "status",
    parameters: { runId },
  });
  const ended = await scene.worker().submit({
    kind: "fail-run",
    commandId: `${name}-fail`,
    runId,
    expectedRevision: Number(record(shown["run"])?.["revision"]),
  });
  assert.equal(ended.kind, "accepted");
  return runId;
}

await test("CLV-356 the queue status batch takes the run IDs of all 16 lanes and refuses more", () =>
  withQueueSpend(async (scene) => {
    const runIds: string[] = [];
    for (let index = 0; index < 5; index += 1)
      runIds.push(await endedRun(scene, `batch-${String(index)}`));
    const five = await call(scene.harness, {
      operation: "status",
      parameters: { runIds },
    });
    assert.equal(five["kind"], "queue-run-statuses", JSON.stringify(five));
    assert.deepEqual(
      items(five["runs"]).map((run) => fields(run)["runId"]),
      runIds,
    );
    const sixteen = await call(scene.harness, {
      operation: "status",
      parameters: {
        runIds: Array.from({ length: 16 }, (_, index) =>
          index < 5 ? runIds[index] : `run-unknown-${String(index)}`,
        ),
      },
    });
    assert.equal(sixteen["code"], "unknown-run");
    const seventeen = await call(scene.harness, {
      operation: "status",
      parameters: {
        runIds: Array.from(
          { length: 17 },
          (_, index) => `run-${String(index)}`,
        ),
      },
    });
    assert.equal(seventeen["code"], "invalid-request");
    assert.match(String(seventeen["detail"] ?? seventeen["message"]), /16/);
  }));
