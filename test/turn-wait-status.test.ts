import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { rendered as cliRendered } from "../src/cli/render.ts";
import { component } from "../src/cli/watch-element.ts";
import { turnOf } from "../src/cli/watch-model.ts";
import { Turn } from "../src/cli/watch-turn.ts";
import { operationKey } from "../src/daemon/operation-journal.ts";
import { turnWaitsPlace } from "../src/daemon/turn-details.ts";
import { operationOf } from "./effect-fixture.ts";
import { withSweep } from "./record-sweep-fixture.ts";
import { effectScene, requested } from "./service-effect-fixture.ts";
import { field, items, withHarness } from "./service-fixture.ts";
import { view } from "./service-views.ts";
import { boardModel } from "./watch-board-fixture.ts";
import { played } from "./watch-browser.ts";
import { rendered } from "./watch-dom.ts";
import { writeDeclaredWorkflow } from "./workflow-folder-fixture.ts";

const waitingAt = "2026-10-10T11:59:00.000Z";
const waitEndsAt = "2026-10-10T12:02:15.000Z";

const waiting = {
  operationId: "op-1",
  phase: "waiting",
  attempt: 1,
  processId: null,
  startedAt: "2026-10-10T11:50:00.000Z",
  waitMilliseconds: 195_000,
  waitingAt,
};

const shownWait = {
  operationId: "op-1",
  attempt: 1,
  waitingAt,
  waitMilliseconds: 195_000,
  waitEndsAt,
};

await test("CLV-348 the journal read gives each turn in its retry wait, also after the old service stopped for a restart", () =>
  withSweep(async (scene) => {
    const folder = (operationId: string, started: unknown) =>
      scene.folder(`journal/${operationKey(operationId)}`, started);
    await rm(join(await folder("op-1", waiting), "result.json"));
    const kept = await folder("op-2", waiting);
    await writeFile(
      join(kept, "result.json"),
      JSON.stringify({ outcome: "stopped", stoppedBy: "daemon-shutdown" }),
    );
    const stopped = await folder("op-3", waiting);
    await writeFile(
      join(stopped, "result.json"),
      JSON.stringify({ outcome: "stopped" }),
    );
    await folder("op-4", { phase: "running", attempt: 1, processId: 1 });
    await folder("op-5", { ...waiting, waitingAt: "not a time" });
    const unknown = await folder("op-7", {
      ...waiting,
      waitingAt: "2026-13-45T10:01:00.000Z",
    });
    await rm(join(unknown, "result.json"));
    const read = turnWaitsPlace(scene.settings()).read;
    assert.deepEqual(
      await read(["op-1", "op-2", "op-3", "op-4", "op-5", "op-6", "op-7"]),
      [shownWait, { ...shownWait, operationId: "op-2" }],
    );
  }));

await test("CLV-348 the run status shows each turn in its retry wait with the time that remains", () =>
  withHarness(async (harness) => {
    const declaration = await writeDeclaredWorkflow(harness.projectDirectory);
    const asked: (readonly string[])[] = [];
    const scene = await effectScene(harness, {
      effectLimit: 20,
      workflowId: declaration.workflow.workflowId,
      capabilities: ["claude", "fake-harness"],
      turnWaits: {
        read: (operationIds) => {
          asked.push(operationIds);
          return Promise.resolve(
            operationIds.map((operationId) => ({ ...shownWait, operationId })),
          );
        },
      },
    });
    assert.equal(
      field(await view(harness, scene.runId), "turnWaits"),
      undefined,
    );
    await requested(scene, {
      commandId: "request-turn",
      round: 1,
      capability: "claude",
    });
    await requested(scene, {
      commandId: "request-other",
      round: 2,
      capability: "fake-harness",
    });
    const operationId = operationOf(scene.runId, { round: 1 });
    const status = await view(harness, scene.runId);
    assert.deepEqual(asked.at(-1), [operationId]);
    assert.deepEqual(items(field(status, "turnWaits")), [
      { ...shownWait, operationId, remainingMilliseconds: 135_000 },
    ]);
    scene.clock.now = "2026-10-10T12:05:00.000Z";
    assert.equal(
      field(
        items(field(await view(harness, scene.runId), "turnWaits"))[0],
        "remainingMilliseconds",
      ),
      0,
    );
    await scene.service.close();
  }));

await test("CLV-348 cloving status names the next attempt, its start and the seconds that remain", () => {
  const text = cliRendered({
    kind: "run-status",
    run: {
      runId: "run-1",
      workflowId: "develop",
      state: "running",
      turnWaits: [
        { ...shownWait, attempt: 2, remainingMilliseconds: 134_400 },
        { operationId: 7 },
      ],
    },
  });
  assert.match(
    text,
    new RegExp(
      `^Worker turn op-1 waits for a retry: attempt 3 starts at ${waitEndsAt}, 135 s left$`,
      "m",
    ),
  );
  assert.equal(text.match(/waits for a retry/g)?.length, 1);
});

await test("CLV-348 the watch page shows a turn in its retry wait as in work with the time that remains, also after the restart", () => {
  const records = { key: "op-1", started: waiting, result: null, activity: [] };
  const kept = {
    ...records,
    result: { outcome: "stopped", stoppedBy: "daemon-shutdown" },
  };
  const now = "2026-10-10T12:00:00.000Z";
  for (const shown of [records, kept]) {
    const turn = turnOf(shown);
    assert.equal(turn.outcome, "in work");
    assert.deepEqual(turn.wait, shownWait);
    const html = rendered(component(Turn, { turn, now }));
    assert.match(
      html,
      /Waits for a retry: attempt 2 starts at [^<]+, 2 min 15 s left/,
    );
  }
  const stopped = turnOf({ ...records, result: { outcome: "stopped" } });
  assert.equal(stopped.outcome, "stopped");
  assert.equal(stopped.wait, undefined);
  assert.doesNotMatch(
    rendered(component(Turn, { turn: stopped, now })),
    /Waits for a retry/,
  );
});

await test("CLV-348 the serialized watch page shows the retry wait of a turn on the run page", () => {
  const operationId = JSON.stringify([
    "cloving-operation",
    1,
    "run-1",
    "implement",
    "claude-turn",
    null,
    null,
  ]);
  const turn = turnOf({
    key: "op-1",
    started: { ...waiting, operationId },
    result: null,
    activity: [],
  });
  const model = boardModel(
    [{ status: { runId: "run-1", workflowId: "develop", state: "running" } }],
    { turns: [turn] },
  );
  const result = played(
    model,
    `
location.hash = "#run=run-1";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
console.log(JSON.stringify({ html: app.inner }));
`,
  );
  assert.match(
    String(result["html"]),
    /class="now">Waits for a retry: attempt 2 starts at [^<]+, [^<]+ left</,
  );
  assert.match(
    String(result["html"]),
    /class="turn-wait">Waits for a retry: attempt 2 starts at [^<]+, [^<]+ left</,
  );
});
