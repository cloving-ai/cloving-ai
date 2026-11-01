import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeDeclaredWorkflow } from "./workflow-folder-fixture.ts";
import { ticketRegistrationTable } from "../src/daemon/ticket-registration.ts";
import { rendered } from "../src/cli/render.ts";
import type { Fields } from "../src/protocol.ts";
import {
  reportTurn,
  workerScene,
  scenarioUsage,
  scenarioTotal,
  turnResult,
} from "./worker-report-fixture.ts";
import { field, items, parsed, type Harness } from "./service-fixture.ts";
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
      turns.push({
        operationId: report.operationId,
        usage,
        costUsd: null,
        estimatedCostUsd: null,
        costDisplay: "Price not known",
      });
    }
    const json = await harness.cli(["status", scene.runId, "--json"]);
    assert.equal(json.status, 0, json.stderr);
    const run = field(parsed(json), "run");
    assert.equal(field(run, "workflowId"), "develop");
    assert.equal(field(run, "claudeCostUsd"), null);
    assert.deepEqual(field(run, "usage"), scenarioTotal);
    assert.deepEqual(field(run, "workerTurns"), turns);
    const text = await harness.cli(["status", scene.runId]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Cost so far: Price not known/);
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

await test("CLV-133 status JSON exposes the selected cost display and preserves numeric fields", async () => {
  for (const [costUsd, estimatedCostUsd, costDisplay] of [
    [null, 7.82, "≈ 7.82 USD (estimate)"],
    [0, 7.82, "0.00 USD"],
    [null, null, "Price not known"],
  ] as const)
    await withHarness(async (harness) => {
      const scene = await workerScene(harness);
      await reportTurn(scene, {
        round: 1,
        result: JSON.stringify({
          usage: scenarioTotal,
          costUsd,
          estimatedCostUsd,
        }),
      });
      const json = await harness.cli(["status", scene.runId, "--json"]);
      assert.equal(json.status, 0, json.stderr);
      const run = field(parsed(json), "run");
      assert.equal(field(run, "claudeCostUsd"), costUsd);
      assert.equal(field(run, "estimatedCostUsd"), estimatedCostUsd);
      assert.equal(field(run, "costDisplay"), costDisplay);
      const turns = field(run, "workerTurns");
      assert.ok(Array.isArray(turns));
      assert.equal(field(turns[0], "costUsd"), costUsd);
      assert.equal(field(turns[0], "estimatedCostUsd"), estimatedCostUsd);
      assert.equal(field(turns[0], "costDisplay"), costDisplay);
      const text = await harness.cli(["status", scene.runId]);
      assert.equal(text.status, 0, text.stderr);
      assert.ok(text.stdout.includes(`Cost so far: ${costDisplay}\n`));
    });
});

async function registrations(harness: Harness) {
  const declaration = await writeDeclaredWorkflow(harness.projectDirectory);
  const table = ticketRegistrationTable(
    {
      repository: "/fixture/private-repository",
      command: [
        process.execPath,
        "-e",
        'console.log("# Synthetic issue\\nGitHub issue: fixture/demo#297\\nPrivate ticket body")',
      ],
    },
    [
      { ...declaration.workflow, functionName: "develop" },
      {
        workflowId: "review-run",
        functionName: "reviewRun",
        effectLimit: 4,
        capabilities: ["claude"],
        input: {
          maximumBytes: 4096,
          fields: {
            prompt: { type: "string" },
            rounds: { type: "integer", minimum: 1 },
            publish: { type: "boolean" },
          },
        },
      },
    ],
  );
  return table.slice(4).map((row) => ({
    ...row,
    manifest: harness.registration.manifest,
    availability: "available" as const,
  }));
}

async function assertInputs(
  harness: Harness,
  expected: { readonly runId: string; readonly input: Fields | null },
): Promise<void> {
  const single = await harness.cli(["status", expected.runId, "--json"]);
  const list = await harness.cli(["status", "--json"]);
  for (const result of [single, list]) {
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(
      result.stdout,
      /Private ticket body|private-repository/,
    );
  }
  const listed = items(parsed(list)["runs"]).find(
    (run) => field(run, "runId") === expected.runId,
  );
  for (const run of [parsed(single)["run"], listed]) {
    assert.deepEqual(field(run, "input"), expected.input);
    assert.equal(
      JSON.stringify(field(run, "input")),
      JSON.stringify(expected.input),
    );
  }
}

await test("CLV-181 declared ticket input reaches single and listed JSON status across restart", () =>
  withHarness(async (harness) => {
    const workflows = await registrations(harness);
    const service = await harness.start({ workflows });
    const admitted = await harness.cli([
      "run",
      "develop",
      "--ticket",
      "297",
      "--command-id",
      "input-issue",
      "--json",
    ]);
    assert.equal(admitted.status, 0, admitted.stderr);
    const runId = String(parsed(admitted)["runId"]);
    const status = await harness.cli(["status", runId, "--json"]);
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(field(field(parsed(status), "run"), "input"), {
      ticket: "297",
    });
    assert.doesNotMatch(
      status.stdout,
      /Private ticket body|private-repository/,
    );
    const expected = { runId, input: { ticket: "297" } };
    await assertInputs(harness, expected);
    const plain = await harness.cli(["status", runId]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /^Input: {"ticket":"297"}$/m);
    assert.doesNotMatch(plain.stdout, /Private ticket body|private-repository/);
    await service.close();
    const reopened = await harness.start({ workflows: [] });
    await assertInputs(harness, expected);
    await reopened.close();
  }));

await test("CLV-181 text status shows compact JSON and marks input longer than 200 Unicode characters", () => {
  for (const length of [20, 187, 188, 250]) {
    const input = { prompt: "p".repeat(length) };
    const compact = JSON.stringify(input);
    const output = rendered({ kind: "run-status", run: { input } });
    const expected =
      compact.length > 200 ? `${compact.slice(0, 200)}…` : compact;
    assert.ok(output.includes(`Input: ${expected}\n`), output);
    assert.equal(
      output.split("\n").filter((line) => line.startsWith("Input:")).length,
      1,
    );
  }
  for (const [length, ending] of [
    [188, "😀…"],
    [186, '😀"}'],
    [187, '😀"…'],
    [189, "…"],
  ] as const) {
    const prefix = "p".repeat(length);
    const output = rendered({
      kind: "run-status",
      run: { input: { prompt: `${prefix}😀` } },
    });
    assert.ok(
      output.includes(`Input: {"prompt":"${prefix}${ending}\n`),
      output,
    );
  }
});

await test("CLV-181 text input escapes terminal controls and guards non-object input", () => {
  const output = rendered({
    kind: "run-status",
    run: { input: { prompt: "First\nsecond\u001b[2J\u202e\u200b" } },
  });
  assert.match(
    output,
    /^Input: {"prompt":"First\\nsecond\\u001b\[2J\\u202e\\u200b"}$/m,
  );
  for (const input of [null, undefined, 42, false, "unsubmitted", []])
    assert.match(
      rendered({ kind: "run-status", run: { input } }),
      /^Input: null$/m,
    );
});

await test("CLV-181 declared workflow input reaches single and listed JSON status across restart", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: await registrations(harness),
    });
    await writeFile(
      join(harness.projectDirectory, "input.json"),
      JSON.stringify({
        rounds: 3,
        publish: false,
        prompt: "Check the change.",
      }),
    );
    const admitted = await harness.cli([
      "run",
      "review-run",
      "--input",
      "input.json",
      "--command-id",
      "input-declared",
      "--json",
    ]);
    assert.equal(admitted.status, 0, admitted.stderr);
    const expected = {
      runId: String(parsed(admitted)["runId"]),
      input: { prompt: "Check the change.", publish: false, rounds: 3 },
    };
    await assertInputs(harness, expected);
    await service.close();
    const reopened = await harness.start({ workflows: [] });
    await assertInputs(harness, expected);
    await reopened.close();
  }));
