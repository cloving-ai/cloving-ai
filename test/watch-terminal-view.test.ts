import assert from "node:assert/strict";
import { test } from "node:test";
import { codexStream } from "../src/daemon/codex-stream.ts";
import {
  transcriptEntries,
  type TranscriptEntry,
} from "../src/turn-transcript.ts";
import { entry } from "./turn-transcript-fixture.ts";
import {
  call,
  numbered,
  result,
  terminal,
  tree,
  visible,
} from "./watch-terminal-fixture.ts";

await test("CLV-333 a Bash call with 30 lines of output shows the call with the command, then its output after the gutter with 4 lines and a count of 26 more lines that opens the rest", () => {
  const html = terminal(
    call(1, { tool: "Bash", input: { command: "npm test\necho done" } }),
    result(2, { callId: "call-1", text: `${numbered(1, 30)}\n` }),
  );
  const input = JSON.stringify(
    { command: "npm test\necho done" },
    null,
    2,
  ).replaceAll('"', "&quot;");
  assert.ok(
    html.includes(
      `<div class="entry tool-call"><details class="tool-line"><summary><span class="mark">⏺</span> <strong class="tool-name">Bash</strong>(npm test)</summary><pre class="tool-input">${input}</pre></details><div class="entry tool-result"><span class="gutter">⎿</span><div class="output"><pre>${numbered(1, 4)}</pre><details><summary>… +26 lines</summary><pre>${numbered(5, 30)}</pre></details></div></div></div>`,
    ),
    html,
  );
});

const fullTurn: readonly TranscriptEntry[] = [
  entry(1, { kind: "prompt", text: "Fix CLV-333." }),
  entry(2, { kind: "assistant", text: "I read the ticket.\nThen I test." }),
  call(3, { tool: "Bash", input: { command: "npm test" } }),
  result(4, { callId: "call-3", text: numbered(1, 30) }),
  call(5, { tool: "Read", input: { file_path: `${tree}/src/a.ts` } }),
  result(6, { callId: "call-5", text: "export const a = 1;" }),
  call(7, {
    tool: "Edit",
    input: {
      file_path: `${tree}/src/a.ts`,
      old_string: "export const a = 1;\nexport const b = 2;\n// end",
      new_string:
        "export const a = 2;\nexport const c = 3;\nexport const b = 2;\n// end",
    },
  }),
  result(8, { callId: "call-7", text: "The file was updated." }),
  call(9, {
    tool: "TodoWrite",
    input: {
      todos: [
        { content: "Write the test", status: "completed" },
        { content: "Write the view", status: "in_progress" },
        { content: "Run the gate", status: "pending" },
      ],
    },
  }),
  result(10, { callId: "call-9", text: "Todos were modified." }),
  entry(11, { kind: "thinking", text: "The view needs a group." }),
  entry(12, {
    kind: "result",
    text: "Turn end: success · cost 0.42 USD · 3 turns · stop reason end_turn",
  }),
];

await test("CLV-333 a turn with a prompt, text, a Bash call with 30 lines of output, a Read call, an Edit call, a todo list, thinking and the result shows each entry in the form of the Claude Code terminal, in order", () => {
  const html = terminal(...fullTurn);
  assert.deepEqual(visible(html.slice(html.indexOf("transcript-lines"))), [
    'transcript-lines" data-transcript="operation-1">> Fix CLV-333.',
    "⏺I read the ticket.",
    "Then I test.",
    "⏺ Bash(npm test)",
    "⎿line 1",
    "line 2",
    "line 3",
    "line 4",
    "… +26 lines",
    "⏺ Read(src/a.ts)",
    "⎿export const a = 1;",
    "⏺ Edit(src/a.ts)",
    "⎿Updated src/a.ts with 2 additions and 1 removal",
    "- export const a = 1;",
    "+ export const a = 2;",
    "+ export const c = 3;",
    "⏺ Update Todos",
    "⎿☒ Write the test",
    "☐ Write the view",
    "☐ Run the gate",
    "✻ Thinking…",
    "Turn end: success · cost 0.42 USD · 3 turns · stop reason end_turn",
  ]);
  assert.ok(
    html.includes(
      '<div class="entry prompt"><span class="mark">&gt; </span><div class="output"><pre>Fix CLV-333.</pre></div></div><div class="entry assistant"><span class="mark">⏺</span><pre>I read the ticket.\nThen I test.</pre></div>',
    ),
    html,
  );
  assert.ok(
    html.includes(
      '<div class="diff"><div class="removed">- export const a = 1;</div><div class="added">+ export const a = 2;</div><div class="added">+ export const c = 3;</div></div>',
    ),
    html,
  );
  assert.ok(
    html.includes(
      '<div class="todo done">☒ <span class="todo-text">Write the test</span></div><div class="todo doing">☐ <span class="todo-text">Write the view</span></div><div class="todo open">☐ <span class="todo-text">Run the gate</span></div>',
    ),
    html,
  );
  assert.ok(
    html.includes(
      '<details class="entry thinking"><summary>✻ Thinking…</summary><pre>The view needs a group.</pre></details>',
    ),
    html,
  );
  assert.doesNotMatch(html, /The file was updated|Todos were modified/);
});

await test("CLV-333 two parallel tool calls followed by their two results show each result under its own call, and a result with no matching call shows alone", () => {
  const html = terminal(
    call(1, { tool: "Read", input: { file_path: "/other/a.ts" } }),
    call(2, { tool: "Bash", input: { command: "npm test" } }),
    result(3, { callId: "call-2", text: "1 test failed", error: true }),
    result(4, { callId: "call-1", text: "export const a = 1;" }),
    result(5, { callId: "lost", text: "orphan output" }),
  );
  const lines = visible(html).filter(
    (line) => line.startsWith("⏺") || line.startsWith("⎿"),
  );
  assert.deepEqual(lines, [
    "⏺ Read(/other/a.ts)",
    "⎿export const a = 1;",
    "⏺ Bash(npm test)",
    "⎿1 test failed",
    "⎿orphan output",
  ]);
  assert.ok(
    html.includes(
      '<div class="entry tool-result error"><span class="gutter">⎿</span><div class="output"><pre>1 test failed</pre></div></div></div><div class="entry tool-result"><span class="gutter">⎿</span><div class="output"><pre>orphan output</pre></div></div></div>',
    ),
    html,
  );
});

await test("CLV-333 each tool call shows the argument of its tool, and a call without a parsed input shows its summary", () => {
  const long = "x".repeat(130);
  const cases: readonly [string, unknown, string][] = [
    ["Bash", { command: long }, `${"x".repeat(120)}…`],
    ["Write", { file_path: `${tree}/a.md`, content: "" }, "a.md"],
    ["MultiEdit", { file_path: `${tree}/b.ts`, edits: [] }, "b.ts"],
    ["NotebookEdit", { notebook_path: `${tree}/c.ipynb` }, "c.ipynb"],
    [
      "Grep",
      { pattern: "TODO", path: `${tree}/src` },
      'pattern: "TODO", path: "src"',
    ],
    ["Grep", { pattern: "TODO" }, 'pattern: "TODO"'],
    ["Grep", { pattern: "TODO", path: tree }, 'pattern: "TODO", path: "."'],
    ["Read", { file_path: "/other/clv-333.ts" }, "/other/clv-333.ts"],
    ["Glob", { pattern: "**/*.ts" }, "**/*.ts"],
    ["WebFetch", { url: "https://example.com" }, "https://example.com"],
    ["WebSearch", { query: "claude code" }, "claude code"],
    ["Task", { description: "Find the bug", prompt: "Look" }, "Find the bug"],
    ["Agent", { description: "Review", prompt: "Look" }, "Review"],
    ["mcp__notes__read", { limit: 3, name: "notes.md" }, "notes.md"],
    ["Exit", {}, ""],
  ];
  for (const [tool, input, argument] of cases)
    assert.ok(
      visible(terminal(call(1, { tool, input }))).includes(
        `⏺ ${tool}(${argument})`,
      ),
      tool,
    );
  const cut = entry(1, {
    kind: "tool-call",
    tool: "Bash",
    summary: "Bash: npm run long",
    text: '{\n  "command": "npm run lo',
    omittedBytes: 70_000,
  });
  const html = terminal(cut);
  assert.ok(visible(html).includes("⏺ Bash(npm run long)"), html);
  assert.match(html, /The output is cut: 70000 bytes are left out\./);
});

await test("CLV-333 a Write call shows the count of lines and the first 4 lines, a MultiEdit call counts all its edits, and an edit with an error result shows the error in place of the diff", () => {
  const written = visible(
    terminal(
      call(1, {
        tool: "Write",
        input: {
          file_path: `${tree}/notes.md`,
          content: `${numbered(1, 6)}\n`,
        },
      }),
      result(2, { callId: "call-1", text: "File created." }),
    ),
  );
  const wrote = written.indexOf("⎿Wrote 6 lines to notes.md");
  assert.deepEqual(written.slice(wrote), [
    "⎿Wrote 6 lines to notes.md",
    ...numbered(1, 4).split("\n"),
    "… +2 lines",
  ]);
  assert.ok(!written.includes("File created."));
  const multi = visible(
    terminal(
      call(1, {
        tool: "MultiEdit",
        input: {
          file_path: `${tree}/a.ts`,
          edits: [
            { old_string: "a", new_string: "b" },
            { old_string: "", new_string: "c\nd" },
          ],
        },
      }),
      result(2, { callId: "call-1", text: "Done." }),
    ),
  );
  assert.ok(multi.includes("⎿Updated a.ts with 3 additions and 1 removal"));
  const failed = visible(
    terminal(
      call(1, {
        tool: "Edit",
        input: { file_path: "a.ts", old_string: "a", new_string: "b" },
      }),
      result(2, { callId: "call-1", text: "String not found.", error: true }),
    ),
  );
  assert.ok(failed.includes("⎿String not found."), failed.join("\n"));
  assert.ok(!failed.some((line) => line.startsWith("⎿Updated")));
  const empty = visible(
    terminal(
      call(1, { tool: "Write", input: { file_path: "e.md", content: "" } }),
      result(2, { callId: "call-1", text: "Done." }),
      call(3, { tool: "Bash", input: { command: "true" } }),
      result(4, { callId: "call-3", text: "\n" }),
    ),
  );
  assert.ok(empty.includes("⎿Wrote 0 lines to e.md"), empty.join("\n"));
  assert.ok(empty.includes("⎿(No content)"), empty.join("\n"));
});

function markedLines(html: string): string[] {
  return visible(html).filter((line) => /^[⏺⎿+-]/.test(line));
}

const changeCalls: readonly TranscriptEntry[] = [
  call(1, {
    tool: "Edit",
    input: { file_path: `${tree}/a.ts`, old_string: "a", new_string: "b" },
  }),
  call(2, {
    tool: "MultiEdit",
    input: {
      file_path: `${tree}/b.ts`,
      edits: [{ old_string: "a", new_string: "b" }],
    },
  }),
  call(3, {
    tool: "Write",
    input: { file_path: `${tree}/c.md`, content: "c" },
  }),
  call(4, {
    tool: "TodoWrite",
    input: { todos: [{ content: "Run the gate", status: "pending" }] },
  }),
];

await test("CLV-333 an Edit, a MultiEdit, a Write or a todo list call shows no detail before its result, so a call that has not ended does not look done", () => {
  assert.deepEqual(markedLines(terminal(...changeCalls)), [
    "⏺ Edit(a.ts)",
    "⏺ MultiEdit(b.ts)",
    "⏺ Write(c.md)",
    "⏺ Update Todos",
  ]);
  const results = [1, 2, 3, 4].map((place) =>
    result(place + 4, { callId: `call-${String(place)}`, text: "Done." }),
  );
  assert.deepEqual(markedLines(terminal(...changeCalls, ...results)), [
    "⏺ Edit(a.ts)",
    "⎿Updated a.ts with 1 addition and 1 removal",
    "- a",
    "+ b",
    "⏺ MultiEdit(b.ts)",
    "⎿Updated b.ts with 1 addition and 1 removal",
    "- a",
    "+ b",
    "⏺ Write(c.md)",
    "⎿Wrote 1 line to c.md",
    "⏺ Update Todos",
    "⎿☐ Run the gate",
  ]);
});

await test("CLV-333 an edit whose input does not give the old and the new text, as a Codex file change, shows the updated path with no counts and no diff", () => {
  const html = terminal(
    call(1, { tool: "Edit", input: { file_path: `${tree}/a.ts` } }),
    result(2, { callId: "call-1", text: "Done." }),
    call(3, {
      tool: "MultiEdit",
      input: {
        file_path: `${tree}/b.ts`,
        edits: [{ old_string: "a", new_string: "b" }, "not an edit"],
      },
    }),
    result(4, { callId: "call-3", text: "Done." }),
  );
  assert.deepEqual(markedLines(html), [
    "⏺ Edit(a.ts)",
    "⎿Updated a.ts",
    "⏺ MultiEdit(b.ts)",
    "⎿Updated b.ts",
  ]);
  assert.doesNotMatch(html, /class="diff"/);
});

await test("CLV-333 a changed file of a Codex turn shows only its call, with no counts", () => {
  const change = { path: `${tree}/a.ts`, kind: "update" };
  const item = { id: "item_1", type: "file_change", changes: [change] };
  const lines = codexStream().line(
    JSON.stringify({
      type: "item.completed",
      item: { ...item, status: "completed" },
    }),
  );
  const entries = transcriptEntries({
    text: `${lines.join("\n")}\n`,
    open: false,
    attempts: [],
    prompts: [],
    privateTexts: [],
  });
  assert.deepEqual(markedLines(terminal(...entries)), ["⏺ Edit(a.ts)"]);
});

await test("CLV-333 a prompt shows its first 12 lines and a count of the other lines that opens the rest, and an error result line shows its error class", () => {
  const html = terminal(
    entry(1, { kind: "prompt", text: numbered(1, 15) }),
    entry(2, { kind: "notice", text: "Session started" }),
    entry(3, { kind: "result", text: "Turn end: error", error: true }),
  );
  assert.ok(
    html.includes(
      `<pre>${numbered(1, 12)}</pre><details><summary>… +3 lines</summary><pre>${numbered(13, 15)}</pre></details>`,
    ),
    html,
  );
  assert.ok(
    html.includes(
      '<div class="entry notice"><pre>Session started</pre></div><div class="entry result error"><pre>Turn end: error</pre></div>',
    ),
    html,
  );
});

await test("CLV-333 a tool result with masked texts and a script tag shows the masks and the tag as text", () => {
  const masked = transcriptEntries({
    text: `${JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content:
              "token ghp_secret123 for Acme Private <script>alert(1)</script>",
          },
        ],
      },
    })}\n`,
    open: false,
    attempts: [],
    prompts: [],
    privateTexts: ["acme private"],
  });
  const html = terminal(
    call(0, { tool: "Bash", input: { command: "cat" }, callId: "call-1" }),
    ...masked,
  );
  assert.ok(
    html.includes(
      "<pre>token [hidden] for [hidden] &lt;script&gt;alert(1)&lt;/script&gt;</pre>",
    ),
    html,
  );
  assert.doesNotMatch(html, /<script>|ghp_secret123|Acme Private/);
});
