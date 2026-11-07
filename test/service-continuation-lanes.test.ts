import assert from "node:assert/strict";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { call } from "./service-fixture.ts";
import { withQueueSpend } from "./queue-spend-fixture.ts";

await test("CLV-321 with 4 of 4 lanes busy, a continuation of a queue run is refused with continuation-lanes-full", () =>
  withQueueSpend(
    async (scene) => {
      const runId = await scene.begin("stopped");
      await scene.turn(runId, { costUsd: 1 });
      const shown = await call(scene.harness, {
        operation: "status",
        parameters: { runId },
      });
      const failed = await scene.worker().submit({
        kind: "fail-run",
        commandId: "stopped-fail",
        runId,
        expectedRevision: Number(record(shown["run"])?.["revision"]),
      });
      assert.equal(failed.kind, "accepted");
      const busy = [];
      for (const name of ["first", "second", "third", "fourth"])
        busy.push(await scene.begin(name));
      const continued = () =>
        call(scene.harness, {
          operation: "continue-run",
          parameters: {
            runId,
            commandId: "lanes-continue",
            from: "work/turn/1",
          },
        });
      const refused = await continued();
      assert.deepEqual(
        [refused["code"], refused["busy"], refused["lanes"]],
        ["continuation-lanes-full", 4, 4],
      );
      assert.match(String(refused["detail"]), /4 of 4 lanes are busy/);
      await scene.finish(String(busy[0]));
      assert.equal((await continued())["kind"], "run-continued");
    },
    { limitUsd: 1000, lanes: 4 },
  ));

await test("CLV-321 a continuation of a run outside the queue takes no lane", () =>
  withQueueSpend(
    async (scene) => {
      const runId = await scene.begin("manual-stopped", "manual");
      await scene.turn(runId, { costUsd: 1 });
      const shown = await call(scene.harness, {
        operation: "status",
        parameters: { runId },
      });
      await scene.worker().submit({
        kind: "fail-run",
        commandId: "manual-fail",
        runId,
        expectedRevision: Number(record(shown["run"])?.["revision"]),
      });
      for (const name of ["first", "second"]) await scene.begin(name);
      const continued = await call(scene.harness, {
        operation: "continue-run",
        parameters: {
          runId,
          commandId: "manual-continue",
          from: "work/turn/1",
        },
      });
      assert.equal(continued["kind"], "run-continued");
    },
    { limitUsd: 1000 },
  ));
