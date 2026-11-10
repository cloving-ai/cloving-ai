import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { Transcript } from "../src/cli/watch-transcript-view.ts";
import {
  transcriptEntries,
  type TranscriptEntry,
} from "../src/turn-transcript.ts";
import { rendered } from "./watch-dom.ts";
import { entry } from "./turn-transcript-fixture.ts";
import { sampleTurn } from "./watch-sample.ts";

const worktree = "clv-333";
const tree = `/work/trees/${worktree}`;

function terminal(...entries: readonly TranscriptEntry[]): string {
  const turn = sampleTurn({ worktree, outcome: "in work" });
  return rendered(
    component(Transcript, {
      run: { runId: "run-1", turns: [turn] },
      turn,
      turnId: null,
      controls: {
        view: () => ({
          shown: true,
          entries,
          state: "open",
          message: "",
          earlier: false,
          unseen: 0,
          detached: false,
        }),
        onToggle: () => undefined,
        onLink: () => undefined,
        onScroll: () => undefined,
        onJump: () => undefined,
        onEarlier: () => undefined,
        onRetry: () => undefined,
      },
    }),
  );
}

function numbered(from: number, to: number): string {
  return Array.from(
    { length: to - from + 1 },
    (_, index) => `line ${String(from + index)}`,
  ).join("\n");
}

function call(
  position: number,
  fields: {
    readonly tool: string;
    readonly input: unknown;
    readonly callId?: string;
  },
): TranscriptEntry {
  return entry(position, {
    kind: "tool-call",
    tool: fields.tool,
    callId: fields.callId ?? `call-${String(position)}`,
    summary: `${fields.tool}: x`,
    text: JSON.stringify(fields.input, null, 2),
  });
}

function result(
  position: number,
  fields: {
    readonly callId: string;
    readonly text: string;
    readonly error?: true;
  },
): TranscriptEntry {
  return entry(position, {
    kind: "tool-result",
    callId: fields.callId,
    text: fields.text,
    error: fields.error === true,
  });
}

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

function visible(html: string): string[] {
  return html
    .replaceAll(/<\/summary>[\s\S]*?<\/details>/g, "</summary>")
    .replaceAll(/<\/(div|summary|pre|p)>/g, "\n")
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

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
            "not an edit",
          ],
        },
      }),
    ),
  );
  assert.ok(
    multi.includes("⎿Updated a.ts with 3 additions and 1 removal"),
    multi.join("\n"),
  );
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
      call(2, { tool: "Bash", input: { command: "true" } }),
      result(3, { callId: "call-2", text: "\n" }),
    ),
  );
  assert.ok(empty.includes("⎿Wrote 0 lines to e.md"), empty.join("\n"));
  assert.ok(empty.includes("⎿(No content)"), empty.join("\n"));
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
