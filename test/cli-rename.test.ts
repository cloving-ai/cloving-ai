import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import { mcpToolCall, mcpTools } from "../src/cli/mcp-tools.ts";
import { record } from "../src/protocol.ts";
import { rendered } from "../src/cli/render.ts";
import { commandUsage, usage } from "../src/cli/usage.ts";

await test("CLV-334 the parser reads rename with a title, an optional label, or --clear", () => {
  assert.deepEqual(
    parseInvocation(["rename", "run-1", "--title", "New name"]),
    {
      kind: "rename",
      runId: "run-1",
      title: "New name",
      label: null,
      clear: false,
      commandId: null,
      json: false,
    },
  );
  assert.deepEqual(
    parseInvocation([
      "rename",
      "run-1",
      "--title",
      " ",
      "--label",
      "SID-4820",
      "--command-id",
      "c-2",
      "--json",
    ]),
    {
      kind: "rename",
      runId: "run-1",
      title: " ",
      label: "SID-4820",
      clear: false,
      commandId: "c-2",
      json: true,
    },
  );
  assert.deepEqual(parseInvocation(["rename", "run-1", "--clear"]), {
    kind: "rename",
    runId: "run-1",
    title: null,
    label: null,
    clear: true,
    commandId: null,
    json: false,
  });
  for (const [code, line] of [
    ["missing-argument", "rename"],
    ["missing-option", "rename run-1"],
    ["missing-option", "rename run-1 --label L-1"],
    ["unexpected-option", "rename run-1 --clear --title Name"],
    ["unexpected-option", "rename run-1 --clear --label L-1"],
    ["unexpected-argument", "rename run-1 run-2 --title Name"],
    ["invalid-option-value", "rename bad!id --title Name"],
    ["invalid-option-value", "rename run-1 --title Name --command-id bad!id"],
  ] as const)
    assert.deepEqual(
      parseInvocation(line.split(" ")),
      { kind: "usage-error", code, json: false },
      line,
    );
});

await test("CLV-334 the human form of a rename names the run, its title, its label and the receipt", () => {
  assert.equal(
    rendered({
      kind: "run-renamed",
      runId: "run-1",
      commandId: "c-1",
      title: "Own name",
      titleSource: "manual",
      label: null,
      labelSource: null,
      replayed: false,
      receipt: { sequence: 12, recordedAt: "2026-10-10T12:00:00.000Z" },
    }),
    "Run run-1 has the title Own name (manual).\nLabel: none\nCommand ID: c-1\nReceipt: sequence 12, recorded at 2026-10-10T12:00:00.000Z\n",
  );
  assert.match(
    rendered({
      kind: "run-status",
      run: { runId: "run-1", title: "Own name", label: "OWN-1" },
    }),
    /\nTitle: Own name\nLabel: OWN-1\n/,
  );
  assert.match(
    String(commandUsage["rename"]),
    /^Usage: cloving rename <run-id> \(--title <text> \[--label <text>\] \| --clear\) \[--command-id <id>\] \[--json\]\n/,
  );
  assert.match(usage, /\n {2}rename {5}Give a run a new title and label\.\n/);
  assert.match(String(commandUsage["mcp"]), /cloving_rename/);
});

await test("CLV-334 the MCP tool cloving_rename sends the same rename request as the CLI", () => {
  assert.deepEqual(
    mcpToolCall({
      name: "cloving_rename",
      arguments: {
        runId: "run-1",
        title: "New",
        label: "L-1",
        commandId: "c-1",
      },
    }),
    {
      kind: "mutation",
      commandId: "c-1",
      request: {
        operation: "rename-run",
        parameters: {
          runId: "run-1",
          commandId: "c-1",
          title: "New",
          label: "L-1",
        },
      },
    },
  );
  assert.deepEqual(
    mcpToolCall({
      name: "cloving_rename",
      arguments: { runId: "run-1", clear: true, commandId: "c-2" },
    }),
    {
      kind: "mutation",
      commandId: "c-2",
      request: {
        operation: "rename-run",
        parameters: { runId: "run-1", commandId: "c-2", clear: true },
      },
    },
  );
  assert.equal(
    mcpToolCall({ name: "cloving_rename", arguments: { runId: "run-1" } }),
    undefined,
  );
  const listed = mcpTools.find((tool) => tool["name"] === "cloving_rename");
  assert.deepEqual(record(listed?.["inputSchema"])?.["required"], [
    "runId",
    "commandId",
  ]);
});
