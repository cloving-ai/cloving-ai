import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fields } from "../src/protocol.ts";
import type { RunTurns, TurnDetails } from "../src/record-retention.ts";
import { operationOf } from "./effect-fixture.ts";
import { field, fields, parsed, withHarness } from "./service-fixture.ts";
import {
  reportTurn,
  scenarioUsage,
  turnResult,
  workerScene,
} from "./worker-report-fixture.ts";

async function shownStatus(found: TurnDetails | undefined) {
  const asked: RunTurns[] = [];
  let shown: { text: string; run: Fields; runId: string } = {
    text: "",
    run: {},
    runId: "",
  };
  await withHarness(async (harness) => {
    const scene = await workerScene(harness);
    await reportTurn(scene, {
      round: 1,
      result: turnResult(scenarioUsage[0], 0.5),
    });
    await scene.service.close();
    const reopened = await harness.start({
      ...scene.options,
      turnDetails: (turns) => {
        asked.push(turns);
        return Promise.resolve(found);
      },
    });
    const text = await harness.cli(["status", scene.runId]);
    assert.equal(text.status, 0, text.stderr);
    const json = await harness.cli(["status", scene.runId, "--json"]);
    assert.equal(json.status, 0, json.stderr);
    shown = {
      text: text.stdout,
      run: fields(field(parsed(json), "run")),
      runId: scene.runId,
    };
    await reopened.close();
  });
  const operationIds = [operationOf(shown.runId, { round: 1 })];
  assert.deepEqual(asked, [
    { runId: shown.runId, operationIds },
    { runId: shown.runId, operationIds },
  ]);
  return shown;
}

await test("CLV-271 status shows the totals of a run with archived records and names the archive journal folder", async () => {
  const folder = "/records/archive/journal";
  const shown = await shownStatus({ state: "archived", folder });
  assert.match(shown.text, /^Cost so far: 0\.50 USD$/m);
  assert.match(shown.text, /^Token usage so far: Input tokens: 1500 · /m);
  assert.match(
    shown.text,
    /^Turn details are archived in the journal folder of the archive: \/records\/archive\/journal$/m,
  );
  assert.equal(field(shown.run, "claudeCostUsd"), 0.5);
  assert.deepEqual(field(shown.run, "usage"), scenarioUsage[0]);
  assert.deepEqual(field(shown.run, "turnDetails"), {
    state: "archived",
    folder,
  });
});

await test("CLV-271 status shows the totals of a run with deleted records and says that the turn details were deleted", async () => {
  const shown = await shownStatus({ state: "deleted" });
  assert.match(shown.text, /^Cost so far: 0\.50 USD$/m);
  assert.match(
    shown.text,
    /^Turn details were deleted by the retention rule$/m,
  );
  assert.deepEqual(field(shown.run, "turnDetails"), { state: "deleted" });
});

await test("CLV-271 status shows no turn details line while the records are kept", async () => {
  const shown = await shownStatus(undefined);
  assert.match(shown.text, /^Cost so far: 0\.50 USD$/m);
  assert.doesNotMatch(shown.text, /Turn details/);
  assert.equal(field(shown.run, "turnDetails"), undefined);
});
