import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyTranscript,
  transcriptAppended,
  transcriptEntries,
  transcriptPage,
  type TranscriptEntry,
} from "../src/turn-transcript.ts";
import {
  assistant,
  entry,
  lines,
  read,
  toolResult,
} from "./turn-transcript-fixture.ts";

const claudeTurn = lines(
  assistant({ type: "text", text: "I read the ticket first." }),
  { type: "system", subtype: "thinking_tokens", estimated_tokens: 12 },
  assistant({ type: "thinking", thinking: "The parser needs a test." }),
  assistant({
    type: "tool_use",
    id: "tool-1",
    name: "Bash",
    input: { command: "npm test", description: "Run the tests" },
  }),
  { type: "tool_progress", tool_name: "Bash", elapsed_time_seconds: 1 },
  toolResult("1 test failed", { error: true }),
  {
    type: "system",
    subtype: "task_started",
    description: "Watch the gate",
    is_backgrounded: true,
  },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 3,
    stop_reason: "end_turn",
    total_cost_usd: 0.4251,
    result: "Done.",
  },
);

await test("CLV-329 a Claude stream gives assistant text, thinking, a tool call, a tool result with an error mark, a background task notice and the result with its cost, in order", () => {
  assert.deepEqual(read(claudeTurn), [
    entry(1, { kind: "assistant", text: "I read the ticket first." }),
    entry(2, { kind: "thinking", text: "The parser needs a test." }),
    entry(3, {
      kind: "tool-call",
      tool: "Bash",
      summary: "Bash: npm test",
      text: JSON.stringify(
        { command: "npm test", description: "Run the tests" },
        null,
        2,
      ),
    }),
    entry(4, { kind: "tool-result", text: "1 test failed", error: true }),
    entry(5, {
      kind: "notice",
      text: "Background task started: Watch the gate",
    }),
    entry(6, {
      kind: "result",
      text: "Turn end: success · cost 0.43 USD · 3 turns · stop reason end_turn",
    }),
  ]);
});

await test("CLV-329 an open turn leaves out its last line until the line is complete", () => {
  const complete = lines(assistant({ type: "text", text: "First." }));
  const partial = `${complete}{"type":"assistant","mess`;
  assert.deepEqual(
    read(partial, { open: true }).map((found) => found.text),
    ["First."],
  );
  assert.deepEqual(
    read(partial).map((found) => found.kind),
    ["assistant", "notice"],
  );
});

await test("CLV-329 a turn with two attempts gives the entries of both, with the attempt line between them", () => {
  const text = `${lines(assistant({ type: "text", text: "Before the restart." }))}\n${lines(assistant({ type: "text", text: "After the restart." }))}`;
  const found = transcriptEntries({
    text,
    open: false,
    attempts: [
      { attempt: 1, resumed: false },
      { attempt: 2, resumed: true },
    ],
    privateTexts: [],
  });
  assert.deepEqual(found, [
    entry(1, { kind: "assistant", text: "Before the restart." }),
    entry(2, {
      kind: "notice",
      attempt: 2,
      text: "Attempt 2 (resumed after a restart)",
    }),
    entry(3, { kind: "assistant", attempt: 2, text: "After the restart." }),
  ]);
});

await test("CLV-329 an attempt after a failure has an attempt line without the restart words", () => {
  const text = `\n${lines(assistant({ type: "text", text: "Again." }))}`;
  assert.deepEqual(
    read(text).map((found) => [found.attempt, found.text]),
    [
      [2, "Attempt 2"],
      [2, "Again."],
    ],
  );
});

await test("CLV-329 the entries mask GitHub tokens and private texts, remove terminal control sequences and keep HTML as text", () => {
  const output = [
    "token ghp_abcDEF123456 and github_pat_11ABC_def",
    "Path of ACME Secret here",
    "\u001b[31mred\u001b[0m and \u001b]0;title\u0007bell\u0000",
    "<script>alert(1)</script> <b>bold</b>",
  ].join("\n");
  const [found] = transcriptEntries({
    text: lines(toolResult(output)),
    open: false,
    attempts: [],
    privateTexts: ["acme secret", " "],
  });
  assert.equal(
    found?.text,
    [
      "token [hidden] and [hidden]",
      "Path of [hidden] here",
      "red and bell",
      "<script>alert(1)</script> <b>bold</b>",
    ].join("\n"),
  );
});

await test("CLV-329 a tool result of 100 KiB keeps its first 64 KiB and counts the bytes it left out", () => {
  const [found] = read(lines(toolResult("y".repeat(102_400))));
  assert.equal(found?.text, "y".repeat(65_536));
  assert.equal(found.omittedBytes, 36_864);
});

await test("CLV-329 the cut of a large output does not split a character", () => {
  const output = `x${"é".repeat(51_200)}`;
  const [found] = read(lines(toolResult(output)));
  assert.equal(found?.text, `x${"é".repeat(32_767)}`);
  assert.equal(found.omittedBytes, 102_401 - 65_535);
});

function many(count: number, size: number): TranscriptEntry[] {
  return Array.from({ length: count }, (_, index) =>
    entry(index + 1, { kind: "assistant", text: "a".repeat(size) }),
  );
}

await test("CLV-329 a page has at most 200 entries after a position and gives the position of its last entry", () => {
  const entries = many(450, 10);
  const first = transcriptPage(entries, { after: 0 });
  assert.equal(first.entries.length, 200);
  assert.equal(first.entries[0]?.position, 1);
  assert.equal(first.nextAfter, 200);
  const last = transcriptPage(entries, { after: 400 });
  assert.equal(last.entries.length, 50);
  assert.equal(last.nextAfter, 450);
  assert.deepEqual(transcriptPage(entries, { after: 450 }), {
    entries: [],
    nextAfter: 450,
  });
});

await test("CLV-329 a page has at most 256 KiB of entries", () => {
  const page = transcriptPage(many(10, 60_000), { after: 0 });
  assert.equal(page.entries.length, 4);
  assert.equal(page.nextAfter, 4);
  const bytes = page.entries.reduce(
    (total, found) =>
      total + new TextEncoder().encode(JSON.stringify(found)).length,
    0,
  );
  assert.ok(bytes <= 262_144, String(bytes));
});

await test("CLV-329 an append read parses only the text after its byte offset and gives the same entries as a full read", () => {
  const first = lines(assistant({ type: "text", text: "Første linje." }));
  const second = `\n${lines(assistant({ type: "text", text: "Again." }))}`;
  const source = {
    attempts: [{ attempt: 2, resumed: true }],
    privateTexts: [],
  };
  const opened = transcriptAppended(emptyTranscript, {
    ...source,
    text: `${first}{"type":"assistant","mess`,
    open: true,
  });
  assert.equal(opened.bytes, Buffer.byteLength(first));
  const ended = transcriptAppended(opened, {
    ...source,
    text: `${second}not json`,
    open: false,
  });
  const full = `${first}${second}not json`;
  assert.equal(ended.bytes, Buffer.byteLength(full));
  assert.equal(ended.attempt, 2);
  assert.deepEqual(
    ended.entries,
    transcriptEntries({ ...source, text: full, open: false }),
  );
});

await test("CLV-329 a summary masks a private text before the cut to 200 characters", () => {
  const secret = "Acme-private-0123456789-0123456789-abcde";
  const [found] = transcriptEntries({
    text: lines(
      assistant({
        type: "tool_use",
        name: "Bash",
        input: { command: `${"a".repeat(180)}\n${secret} done` },
      }),
    ),
    open: false,
    attempts: [],
    privateTexts: [secret],
  });
  assert.equal(found?.summary, `Bash: ${"a".repeat(180)} [hidden] done`);
});
