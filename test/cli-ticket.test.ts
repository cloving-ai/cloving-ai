import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import { field, parsed, withHarness } from "./service-fixture.ts";

function words(line: string): readonly string[] {
  return line.split(" ");
}

await test("CLV-070 next submits the reserved ticket ID and conflicts with every other input source", () => {
  assert.deepEqual(
    parseInvocation(words("run develop-issue --next")),
    parseInvocation(words("run develop-issue --ticket next")),
  );
  for (const source of [
    "--ticket CLV-016",
    "--ticket next",
    "--prompt work",
    "--input input.json",
  ])
    assert.deepEqual(
      parseInvocation(words(`run develop-issue --next ${source}`)),
      {
        kind: "usage-error",
        code: "conflicting-input-sources",
        json: false,
      },
    );
});

await test("CLV-016 the parser reads a ticket ID as the one input source of a run, and it refuses a second source and an ID that is no identifier", () => {
  const run = { kind: "run", workflowId: "develop", commandId: null };
  assert.deepEqual(parseInvocation(words("run develop --ticket CLV-016")), {
    ...run,
    source: { kind: "ticket", id: "CLV-016" },
    json: false,
  });
  assert.deepEqual(parseInvocation(words("run develop --ticket=16 --json")), {
    ...run,
    source: { kind: "ticket", id: "16" },
    json: true,
  });
  for (const [code, line] of [
    ["conflicting-input-sources", "run develop --prompt x --ticket CLV-016"],
    [
      "conflicting-input-sources",
      "run develop --ticket CLV-016 --input f.json",
    ],
    ["invalid-option-value", "run develop --ticket bad!id"],
    ["invalid-option-value", "run develop --ticket="],
    ["invalid-option-value", `run develop --ticket ${"t".repeat(129)}`],
    ["unexpected-option", "status --ticket CLV-016"],
  ] as const)
    assert.deepEqual(parseInvocation(words(line)), {
      kind: "usage-error",
      code,
      json: false,
    });
});

await test("CLV-016 run with a ticket ID gives the workflow the submission field ticket, and a workflow that takes a prompt refuses it", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [
        {
          ...harness.registration,
          submission: { maximumBytes: 4096, fields: { ticket: "string" } },
        },
      ],
    });
    const run = ["run", "develop", "--ticket", "CLV-016", "--json"];
    const admitted = await harness.cli([...run, "--command-id", "c-ticket"]);
    assert.equal(admitted.status, 0, admitted.stderr);
    assert.equal(field(parsed(admitted), "kind"), "run-admitted");
    assert.deepEqual(harness.resolved, [
      {
        workflowId: "develop",
        submission: { ticket: "CLV-016" },
        commandId: "c-ticket",
      },
    ]);
    await service.close();
    const prompted = await harness.start();
    const refused = await harness.cli([...run, "--command-id", "c-second"]);
    assert.equal(refused.status, 1);
    assert.equal(field(parsed(refused), "code"), "invalid-submission");
    await prompted.close();
  }));
