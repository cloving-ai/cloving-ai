import assert from "node:assert/strict";
import { test } from "node:test";
import { call, field, parsed, runCli, withHarness } from "./service-fixture.ts";
import { reportTurn, workerScene } from "./worker-report-fixture.ts";
import { turnOf } from "../src/cli/watch-model.ts";
import { statusTurns } from "../src/cli/watch-usage.ts";
import { Turn } from "../src/cli/watch-turn.ts";
import { component } from "../src/cli/watch-element.ts";
import { rendered } from "./watch-dom.ts";

await test("CLV-210 status and its CLI JSON retain the harness of each turn after restart", () =>
  withHarness(async (harness) => {
    const scene = await workerScene(harness);
    for (const [index, name] of ["codex", "claude"].entries())
      await reportTurn(scene, {
        round: index + 1,
        result: JSON.stringify({ harness: name }),
      });
    const verify = async () => {
      const status = await call(harness, {
        operation: "status",
        parameters: { runId: scene.runId },
      });
      const turns = field(status["run"], "workerTurns");
      assert.deepEqual(
        [
          field(field(turns, "0"), "harness"),
          field(field(turns, "1"), "harness"),
        ],
        ["codex", "claude"],
      );
      const environment = {
        directory: harness.projectDirectory,
        runtime: harness.runtimeDirectory,
      };
      const json = parsed(
        await runCli(["status", scene.runId, "--json"], environment),
      );
      assert.equal(
        field(field(field(json["run"], "workerTurns"), "0"), "harness"),
        "codex",
      );
      const text = await runCli(["status", scene.runId], environment);
      assert.match(text.stdout, /Harness: codex/);
      assert.match(text.stdout, /Harness: claude/);
    };
    await verify();
    await scene.service.close();
    const reopened = await harness.start(scene.options);
    await verify();
    await reopened.close();
  }));

await test("CLV-210 watch shows the harness for active, completed and restored turns", () => {
  const active = turnOf({
    key: "key",
    started: { harness: "codex" },
    result: null,
    activity: [],
  });
  assert.equal(Reflect.get(active, "harness"), "codex");
  assert.match(
    rendered(component(Turn, { turn: active, now: "" })),
    /Harness: codex/,
  );
  const completed = turnOf({
    key: "key",
    started: {},
    result: { outcome: "completed", result: '{"harness":"claude"}' },
    activity: [],
  });
  assert.equal(Reflect.get(completed, "harness"), "claude");
  const restored = statusTurns([], {
    runId: "run",
    workerTurns: [{ operationId: "op", harness: "codex" }],
  });
  assert.equal(Reflect.get(Object(restored[0]), "harness"), "codex");
});
