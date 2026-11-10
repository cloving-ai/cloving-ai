import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyTranscript,
  transcriptAppended,
  transcriptEntries,
} from "../src/turn-transcript.ts";
import { codexStream } from "../src/daemon/codex-stream.ts";
import { assistant, lines, read } from "./turn-transcript-fixture.ts";

function result(callId: string, content: string) {
  return {
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: callId, content }],
    },
  };
}

await test("CLV-333 two parallel tool calls of a Claude stream give two tool-call entries and two tool-result entries with matching call IDs", () => {
  const found = read(
    lines(
      assistant(
        {
          type: "tool_use",
          id: "toolu_read",
          name: "Read",
          input: { file_path: "/work/src/a.ts" },
        },
        {
          type: "tool_use",
          id: "toolu_bash",
          name: "Bash",
          input: { command: "npm test" },
        },
      ),
      result("toolu_bash", "1 test failed"),
      result("toolu_read", "export const a = 1;"),
      assistant({ type: "text", text: "One test fails." }),
    ),
  );
  assert.deepEqual(
    found.map((item) => [item.kind, item.callId, item.tool, item.text]),
    [
      [
        "tool-call",
        "toolu_read",
        "Read",
        '{\n  "file_path": "/work/src/a.ts"\n}',
      ],
      ["tool-call", "toolu_bash", "Bash", '{\n  "command": "npm test"\n}'],
      ["tool-result", "toolu_bash", null, "1 test failed"],
      ["tool-result", "toolu_read", null, "export const a = 1;"],
      ["assistant", null, null, "One test fails."],
    ],
  );
});

await test("CLV-333 the prompt of each attempt comes first in its attempt with the kind prompt, masked, and an open turn with no lines shows the prompt once", () => {
  const turn = lines(assistant({ type: "text", text: "First." }));
  const found = transcriptEntries({
    text: `${turn}\n${turn}`,
    open: false,
    attempts: [{ attempt: 2, resumed: true }],
    prompts: ["Fix CLV-333 with ghp_secret1.", "Go on after the restart."],
    privateTexts: [],
  });
  assert.deepEqual(
    found.map((item) => [item.position, item.attempt, item.kind, item.text]),
    [
      [1, 1, "prompt", "Fix CLV-333 with [hidden]."],
      [2, 1, "assistant", "First."],
      [3, 2, "notice", "Attempt 2 (resumed after a restart)"],
      [4, 2, "prompt", "Go on after the restart."],
      [5, 2, "assistant", "First."],
    ],
  );
  const source = {
    open: true,
    attempts: [],
    prompts: ["Fix CLV-333."],
    privateTexts: [],
  };
  const opened = transcriptAppended(emptyTranscript, { ...source, text: "" });
  assert.deepEqual(
    opened.entries.map((item) => [item.kind, item.text]),
    [["prompt", "Fix CLV-333."]],
  );
  const later = transcriptAppended(opened, { ...source, text: turn });
  assert.deepEqual(
    later.entries.map((item) => [item.position, item.kind]),
    [
      [1, "prompt"],
      [2, "assistant"],
    ],
  );
});

await test("CLV-333 a turn from before the prompt file gives no prompt entry", () => {
  const found = read(lines(assistant({ type: "text", text: "First." })));
  assert.deepEqual(
    found.map((item) => item.kind),
    ["assistant"],
  );
});

await test("CLV-333 a Codex command gives a tool call and its output with the item ID as the call ID, and a failed command gives an error result", () => {
  const stream = codexStream();
  const command = (id: string, extra: Readonly<Record<string, unknown>>) => ({
    id,
    type: "command_execution",
    command: "npm test",
    ...extra,
  });
  const events = [
    { type: "item.started", item: command("item_1", {}) },
    { type: "item.started", item: command("item_2", {}) },
    {
      type: "item.completed",
      item: command("item_2", {
        aggregated_output: "1 failed",
        exit_code: 1,
        status: "failed",
      }),
    },
    {
      type: "item.completed",
      item: command("item_1", {
        aggregated_output: "ok 1\nok 2\n",
        exit_code: 0,
        status: "completed",
      }),
    },
  ];
  const journal = events.flatMap((event) => stream.line(JSON.stringify(event)));
  assert.deepEqual(
    read(lines(...journal)).map((item) => [
      item.kind,
      item.callId,
      item.text,
      item.error,
    ]),
    [
      ["tool-call", "item_1", '{\n  "command": "npm test"\n}', false],
      ["tool-call", "item_2", '{\n  "command": "npm test"\n}', false],
      ["tool-result", "item_2", "1 failed", true],
      ["tool-result", "item_1", "ok 1\nok 2\n", false],
    ],
  );
});
