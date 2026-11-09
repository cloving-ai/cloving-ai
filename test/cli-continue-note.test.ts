import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import { continueServiceRequest } from "../src/cli/continue-arguments.ts";
import { mcpToolCall } from "../src/cli/mcp-tools.ts";
import { rendered } from "../src/cli/render.ts";

const note = "Merge the branch of the first run first.";
const turn = JSON.stringify([
  "cloving-operation",
  1,
  "run-2",
  "implement",
  "claude-turn",
]);

await test("CLV-326 the parser reads run continue with a note and the CLI request carries the note", () => {
  const invocation = parseInvocation([
    "run",
    "continue",
    "run-1",
    "--from",
    "implement/claude-turn",
    "--note",
    note,
  ]);
  assert.deepEqual(invocation, {
    kind: "continue",
    runId: "run-1",
    from: "implement/claude-turn",
    bundle: "retained",
    commandId: null,
    note,
    json: false,
  });
  assert.deepEqual(
    Reflect.get(Object(parseInvocation(["run", "continue", "run-1"])), "note"),
    null,
  );
  assert.deepEqual(
    continueServiceRequest(
      {
        kind: "continue",
        runId: "run-1",
        from: null,
        bundle: "retained",
        commandId: null,
        note: "  ",
        json: false,
      },
      "c-1",
    ),
    {
      operation: "continue-run",
      parameters: {
        runId: "run-1",
        commandId: "c-1",
        bundle: "retained",
        note: "  ",
      },
    },
  );
});

await test("CLV-326 the MCP tool cloving_continue sends a note in the same request as the CLI", () => {
  assert.deepEqual(
    mcpToolCall({
      name: "cloving_continue",
      arguments: { runId: "run-1", note, commandId: "c-1" },
    }),
    {
      kind: "mutation",
      commandId: "c-1",
      request: {
        operation: "continue-run",
        parameters: {
          runId: "run-1",
          commandId: "c-1",
          bundle: "retained",
          note,
        },
      },
    },
  );
  assert.equal(
    mcpToolCall({
      name: "cloving_continue",
      arguments: { runId: "run-1", note: 7, commandId: "c-1" },
    }),
    undefined,
  );
});

await test("CLV-326 the status of a run shows each note with its time and the turn that got it, waiting, or a deleted receipt", () => {
  const text = rendered({
    kind: "run-status",
    run: {
      runId: "run-2",
      workflowId: "develop",
      notes: [
        {
          noteId: "note-a",
          text: note,
          source: "continue",
          recordedAt: "2026-11-08T10:00:00.000Z",
          receivedBy: turn,
        },
        {
          noteId: "note-b",
          text: "Keep the tests.",
          source: "steer",
          recordedAt: "2026-11-08T10:05:00.000Z",
          receivedBy: null,
        },
        {
          noteId: "note-c",
          text: "Use the old branch.",
          source: "continue",
          recordedAt: "2026-11-08T10:06:00.000Z",
          receivedBy: "turn-raw",
        },
        {
          noteId: "note-d",
          text: "Keep the old tests.",
          source: "continue",
          recordedAt: "2026-11-08T10:07:00.000Z",
          receivedBy: null,
          receipt: "deleted",
        },
      ],
    },
  });
  assert.match(
    text,
    /\nNote at 2026-11-08T10:00:00\.000Z from continue, got by implement\/claude-turn\/1: Merge the branch of the first run first\.\nNote at 2026-11-08T10:05:00\.000Z from steer, waiting: Keep the tests\.\nNote at 2026-11-08T10:06:00\.000Z from continue, got by turn-raw: Use the old branch\.\nNote at 2026-11-08T10:07:00\.000Z from continue, receipt deleted by the retention rule: Keep the old tests\.\n/,
  );
});

await test("CLV-326 the status of a run with no notes shows no note line", () => {
  assert.doesNotMatch(
    rendered({
      kind: "run-status",
      run: { runId: "run-1", workflowId: "develop" },
    }),
    /Note at/,
  );
});
