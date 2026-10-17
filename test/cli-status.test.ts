import assert from "node:assert/strict";
import { test } from "node:test";
import { rendered } from "../src/cli/render.ts";
import {
  reportTurn,
  workerScene,
  scenarioUsage,
  scenarioTotal,
  turnResult,
} from "./worker-report-fixture.ts";
import { field, parsed } from "./service-fixture.ts";
import { later, noon, startedRun, withHarness } from "./service-fixture.ts";

await test("CLV-072 plain status lists unused and unavailable workflows and the latest time of each run", () =>
  withHarness(async (harness) => {
    let now = noon;
    const workflows = [
      harness.registration,
      { ...harness.registration, workflowId: "unused" },
      {
        ...harness.registration,
        workflowId: "unavailable",
        availability: "unavailable" as const,
      },
    ];
    const service = await harness.start({ workflows, clock: () => now });
    const empty = await harness.cli(["status"]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /^Workflows: develop, unused, unavailable$/m);
    assert.match(empty.stdout, /^Runs:\n {2}none$/m);
    const first = await startedRun(harness, { service, commandId: "first" });
    now = later;
    const second = await startedRun(harness, { service, commandId: "second" });
    const list = await harness.cli(["status"]);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /^Workflows: develop, unused, unavailable$/m);
    for (const [runId, latestAt] of [
      [first, noon],
      [second, later],
    ])
      assert.ok(
        list.stdout.includes(
          `  ${String(runId)}  develop  working  revision 2  latest at ${String(latestAt)}\n`,
        ),
        list.stdout,
      );
    await service.close();
  }));

await test("CLV-072 plain run status shows the title, completion outcome and latest event time", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      clock: () => noon,
      workflows: [
        {
          ...harness.registration,
          resolver: {
            ...harness.registration.resolver,
            resolve: () =>
              Promise.resolve({
                kind: "resolved" as const,
                input: {
                  cycleId: "cycle-title",
                  ticket: "# CLV-067: Recover GitHub operations",
                },
              }),
          },
        },
      ],
    });
    const runId = await startedRun(harness, { service, commandId: "titled" });
    const active = await harness.cli(["status", runId]);
    assert.equal(active.status, 0, active.stderr);
    assert.match(active.stdout, /^Title: CLV-067: Recover GitHub operations$/m);
    assert.match(active.stdout, /^Outcome: none$/m);
    assert.match(active.stdout, /^Latest at: 2026-10-10T12:00:00.000Z$/m);
    assert.equal(
      (
        await service.worker.submit({
          kind: "complete-run",
          commandId: "completed",
          runId,
          expectedRevision: 2,
          outcome: "blocked",
          outcomeReason: "Greptile gave the confidence score 4/5 in round 4",
        })
      ).kind,
      "accepted",
    );
    const completed = await harness.cli(["status", runId]);
    assert.equal(completed.status, 0, completed.stderr);
    assert.match(completed.stdout, /^State: completed$/m);
    assert.match(
      completed.stdout,
      /^Outcome: blocked: Greptile gave the confidence score 4\/5 in round 4$/m,
    );
    await service.close();
  }));

await test("CLV-072 plain status displays absent metadata and outcomes without a reason", () => {
  for (const outcome of [
    null,
    { kind: "handoff_requested", reason: null },
    { kind: "blocked", reason: null },
  ]) {
    const output = rendered({
      kind: "run-status",
      run: { title: null, latestAt: null, outcome },
    });
    assert.match(output, /^Title: none$/m);
    assert.match(output, /^Latest at: none$/m);
    assert.ok(output.includes(`Outcome: ${outcome?.kind ?? "none"}\n`));
  }
});

await test("CLV-072 plain status escapes terminal controls in titles and completion reasons", () => {
  const output = rendered({
    kind: "run-status",
    run: {
      title: "Task\u001b[2J\u202e",
      outcome: { kind: "blocked", reason: "First\nsecond\u0007" },
    },
  });
  assert.match(output, /^Title: Task\\u001b\[2J\\u202e$/m);
  assert.match(output, /^Outcome: blocked: First\n {4}second\\u0007$/m);
});

await test("CLV-094 status text and JSON show separate worker turns and run totals so far", () =>
  withHarness(async (harness) => {
    const scene = await workerScene(harness);
    const turns = [];
    for (const [index, usage] of scenarioUsage.entries()) {
      const report = await reportTurn(scene, {
        round: index + 1,
        result: turnResult(usage),
        outcome: index === 0 ? "completed" : "failed",
      });
      turns.push({ operationId: report.operationId, usage, costUsd: null });
    }
    const json = await harness.cli(["status", scene.runId, "--json"]);
    assert.equal(json.status, 0, json.stderr);
    const run = field(parsed(json), "run");
    assert.equal(field(run, "workflowId"), "develop-issue");
    assert.equal(field(run, "claudeCostUsd"), null);
    assert.deepEqual(field(run, "usage"), scenarioTotal);
    assert.deepEqual(field(run, "workerTurns"), turns);
    const text = await harness.cli(["status", scene.runId]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Claude cost so far: Price not known/);
    assert.match(
      text.stdout,
      /Token usage so far: Input tokens: 1800 · Cache read tokens: 900 · Output tokens: 170/,
    );
    for (const [index, turn] of turns.entries()) {
      assert.ok(text.stdout.includes(`Worker turn ${turn.operationId}`));
      assert.ok(
        text.stdout.includes(
          `Input tokens: ${String(scenarioUsage[index]?.input_tokens)}`,
        ),
      );
    }
    assert.doesNotMatch(text.stdout, /0\.00 USD/);
  }));
