import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import { mcpToolCall, mcpTools } from "../src/cli/mcp-tools.ts";
import { record } from "../src/protocol.ts";
import { rendered } from "../src/cli/render.ts";
import { commandUsage, usage } from "../src/cli/usage.ts";

await test("CLV-321 the parser reads dismiss with a run ID and a command ID", () => {
  assert.deepEqual(parseInvocation(["dismiss", "run-1"]), {
    kind: "dismiss",
    runId: "run-1",
    commandId: null,
    json: false,
  });
  assert.deepEqual(
    parseInvocation(["dismiss", "run-1", "--command-id", "c-2", "--json"]),
    { kind: "dismiss", runId: "run-1", commandId: "c-2", json: true },
  );
  for (const [code, line] of [
    ["missing-argument", "dismiss"],
    ["unexpected-argument", "dismiss run-1 run-2"],
    ["unexpected-option", "dismiss run-1 --expected-revision 2"],
    ["invalid-option-value", "dismiss bad!id"],
    ["invalid-option-value", "dismiss run-1 --command-id bad!id"],
  ] as const)
    assert.deepEqual(
      parseInvocation(line.split(" ")),
      { kind: "usage-error", code, json: false },
      line,
    );
});

await test("CLV-321 the human form of a dismissal names the run and its receipt", () => {
  assert.equal(
    rendered({
      kind: "run-dismissed",
      runId: "run-1",
      commandId: "c-1",
      replayed: false,
      receipt: { sequence: 12, recordedAt: "2026-10-10T12:00:00.000Z" },
    }),
    "Run run-1 is dismissed. Needs you does not list it.\nCommand ID: c-1\nReceipt: sequence 12, recorded at 2026-10-10T12:00:00.000Z\n",
  );
  assert.match(
    String(commandUsage["dismiss"]),
    /^Usage: cloving dismiss <run-id> \[--command-id <id>\] \[--json\]\n/,
  );
  assert.match(
    usage,
    /\n {2}dismiss {4}Remove a stopped run from Needs you\.\n/,
  );
  assert.match(String(commandUsage["mcp"]), /cloving_dismiss/);
});

await test("CLV-321 the MCP tool cloving_dismiss sends the same dismiss request as the CLI", () => {
  assert.deepEqual(
    mcpToolCall({
      name: "cloving_dismiss",
      arguments: { runId: "run-1", commandId: "c-1" },
    }),
    {
      kind: "mutation",
      commandId: "c-1",
      request: {
        operation: "dismiss-run",
        parameters: { runId: "run-1", commandId: "c-1" },
      },
    },
  );
  assert.equal(
    mcpToolCall({ name: "cloving_dismiss", arguments: { runId: "run-1" } }),
    undefined,
  );
  const listed = mcpTools.find((tool) => tool["name"] === "cloving_dismiss");
  assert.deepEqual(record(listed?.["inputSchema"])?.["required"], [
    "runId",
    "commandId",
  ]);
});
