import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import { mcpToolCall } from "../src/cli/mcp-tools.ts";
import { rendered } from "../src/cli/render.ts";

function continued(changes: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: "continue",
    runId: "run-1",
    from: null,
    bundle: "retained",
    commandId: null,
    note: null,
    json: false,
    ...changes,
  };
}

await test("CLV-307 the parser reads run continue with its step, bundle and command ID", () => {
  assert.deepEqual(parseInvocation(["run", "continue", "run-1"]), continued());
  assert.deepEqual(
    parseInvocation([
      "run",
      "continue",
      "run-1",
      "--from",
      "pull-request/github-open-pr",
      "--bundle",
      "current",
      "--command-id",
      "c-2",
      "--json",
    ]),
    continued({
      from: "pull-request/github-open-pr",
      bundle: "current",
      commandId: "c-2",
      json: true,
    }),
  );
  assert.deepEqual(
    parseInvocation(["run", "continue", "run-1", "--from=merge/merge/2"]),
    continued({ from: "merge/merge/2" }),
  );
});

await test("CLV-307 the parser refuses a run continue line that is not complete or not valid", () => {
  for (const [code, line] of [
    ["missing-argument", "run continue"],
    ["unexpected-argument", "run continue run-1 run-2"],
    ["unexpected-option", "run continue run-1 --prompt x"],
    ["invalid-option-value", "run continue bad!id"],
    ["invalid-option-value", "run continue run-1 --bundle old"],
    ["invalid-option-value", "run continue run-1 --from merge"],
    ["invalid-option-value", "run continue run-1 --command-id bad!id"],
  ] as const)
    assert.deepEqual(
      parseInvocation(line.split(" ")),
      {
        kind: "usage-error",
        code,
        json: false,
      },
      line,
    );
});

await test("CLV-307 the human form of a continuation names the old run and the start of the replay", () => {
  assert.equal(
    rendered({
      kind: "run-continued",
      runId: "run-2",
      continuedFrom: "run-1",
      commandId: "c-1",
      replayed: false,
      reuseBefore: 9,
      receipt: { sequence: 12, recordedAt: "2026-10-10T12:00:00.000Z" },
    }),
    "Run run-2 continues run-1. The steps from event 9 run again.\nCommand ID: c-1\nReceipt: sequence 12, recorded at 2026-10-10T12:00:00.000Z\n",
  );
});

await test("CLV-307 the status of a run shows the run that it continues and the run that continues it", () => {
  const text = rendered({
    kind: "run-list",
    workflows: [],
    runs: [
      {
        runId: "run-1",
        workflowId: "develop",
        condition: "failed",
        revision: 3,
        continuedBy: "run-2",
      },
      {
        runId: "run-2",
        workflowId: "develop",
        condition: "working",
        revision: 2,
        continuedFrom: "run-1",
      },
    ],
  });
  assert.match(
    text,
    /run-1 .*\n.*\n.*\n.*Child runs: none\n {4}Continued by: run-2\n/,
  );
  assert.match(
    text,
    /run-2 .*\n.*\n.*\n.*Child runs: none\n {4}Continues: run-1\n/,
  );
});

await test("CLV-307 the MCP tool cloving_continue sends the same continue request as the CLI", () => {
  assert.deepEqual(
    mcpToolCall({
      name: "cloving_continue",
      arguments: {
        runId: "run-1",
        from: "merge/merge/1",
        bundle: "current",
        commandId: "c-1",
      },
    }),
    {
      kind: "mutation",
      commandId: "c-1",
      request: {
        operation: "continue-run",
        parameters: {
          runId: "run-1",
          commandId: "c-1",
          bundle: "current",
          from: "merge/merge/1",
        },
      },
    },
  );
  assert.equal(
    mcpToolCall({
      name: "cloving_continue",
      arguments: { runId: "run-1", from: "merge", commandId: "c-1" },
    }),
    undefined,
  );
  assert.equal(
    mcpToolCall({
      name: "cloving_continue",
      arguments: { runId: "run-1", bundle: "old", commandId: "c-1" },
    }),
    undefined,
  );
});
