import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import { mcpToolCall, mcpTools } from "../src/cli/mcp-tools.ts";
import { record } from "../src/protocol.ts";
import { rendered } from "../src/cli/render.ts";
import { commandUsage, usage } from "../src/cli/usage.ts";

const note = "Change only src/cli.ts.";
const receipt = { sequence: 12, recordedAt: "2026-11-08T12:00:00.000Z" };
const turn = JSON.stringify([
  "cloving-operation",
  2,
  "run-1",
  "implement",
  "claude-turn",
]);

await test("CLV-327 the parser reads steer with a run ID, a note, now and a command ID", () => {
  assert.deepEqual(parseInvocation(["steer", "run-1", "--text", note]), {
    kind: "steer",
    runId: "run-1",
    text: note,
    now: false,
    commandId: null,
    json: false,
  });
  assert.deepEqual(
    parseInvocation(
      ["steer", "run-1", "--text", note, "--now"].concat([
        "--command-id",
        "c-2",
        "--json",
      ]),
    ),
    {
      kind: "steer",
      runId: "run-1",
      text: note,
      now: true,
      commandId: "c-2",
      json: true,
    },
  );
  for (const [code, line] of [
    ["missing-argument", ["steer"]],
    ["missing-option", ["steer", "run-1"]],
    ["unexpected-argument", ["steer", "run-1", "run-2", "--text", note]],
    ["unexpected-option", ["steer", "run-1", "--text", note, "--from", "a/b"]],
    ["invalid-option-value", ["steer", "bad!id", "--text", note]],
  ] as const)
    assert.deepEqual(
      parseInvocation(line),
      { kind: "usage-error", code, json: false },
      line.join(" "),
    );
});

await test("CLV-327 the human form of a note names the run, its delivery and its receipt", () => {
  const noted = {
    kind: "run-noted",
    runId: "run-1",
    commandId: "c-1",
    noteId: "note-a",
    replayed: false,
    receipt,
  };
  const tail = `Command ID: c-1\nReceipt: sequence 12, recorded at ${receipt.recordedAt}\n`;
  assert.equal(
    rendered({ ...noted, delivery: "now", operationId: turn }),
    `Run run-1 has the note note-a.\nThe turn in work got the note: implement/claude-turn/2.\n${tail}`,
  );
  assert.equal(
    rendered({ ...noted, delivery: "queued", reason: "no-session" }),
    `Run run-1 has the note note-a.\nThe note waits for the next turn of the run (queued: no-session).\n${tail}`,
  );
  assert.equal(
    rendered({ ...noted, delivery: "queued" }),
    `Run run-1 has the note note-a.\nThe note waits for the next turn of the run (queued).\n${tail}`,
  );
  assert.equal(
    rendered({ ...noted, replayed: true }),
    `Run run-1 has the note note-a.\nThe note is recorded.\n${tail}This is the receipt of the earlier equal command.\n`,
  );
  assert.match(
    String(commandUsage["steer"]),
    /^Usage: cloving steer <run-id> --text <note> \[--now\] \[--command-id <id>\] \[--json\]\n/,
  );
  assert.match(usage, /\n {2}steer {6}Send a note to a run in work\.\n/);
  assert.match(String(commandUsage["mcp"]), /cloving_steer/);
});

await test("CLV-327 the MCP tool cloving_steer sends the same steer request as the CLI", () => {
  assert.deepEqual(
    mcpToolCall({
      name: "cloving_steer",
      arguments: { runId: "run-1", text: note, now: true, commandId: "c-1" },
    }),
    {
      kind: "mutation",
      commandId: "c-1",
      request: {
        operation: "steer-run",
        parameters: { runId: "run-1", commandId: "c-1", note, now: true },
      },
    },
  );
  assert.deepEqual(
    mcpToolCall({
      name: "cloving_steer",
      arguments: { runId: "run-1", text: note, commandId: "c-1" },
    }),
    {
      kind: "mutation",
      commandId: "c-1",
      request: {
        operation: "steer-run",
        parameters: { runId: "run-1", commandId: "c-1", note, now: false },
      },
    },
  );
  for (const values of [
    { runId: "run-1", commandId: "c-1" },
    { runId: "run-1", text: note, now: "yes", commandId: "c-1" },
  ])
    assert.equal(
      mcpToolCall({ name: "cloving_steer", arguments: values }),
      undefined,
    );
  const listed = mcpTools.find((tool) => tool["name"] === "cloving_steer");
  assert.deepEqual(record(listed?.["inputSchema"])?.["required"], [
    "runId",
    "text",
    "commandId",
  ]);
});
