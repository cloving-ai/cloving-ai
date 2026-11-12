import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyTranscript,
  transcriptAppended,
  transcriptPage,
} from "../src/turn-transcript.ts";
import { assistant, lines, read } from "./turn-transcript-fixture.ts";
import { piStream } from "../src/daemon/pi-stream.ts";
import { piEvents } from "./pi-fixture.ts";
import { resultOf } from "./claude-worker-fixture.ts";
import { piActivity } from "../src/daemon/pi-activity.ts";

await test("CLV-364 Pi emits each text delta for live transcript display", () => {
  const stream = piStream();
  stream.line(JSON.stringify({ type: "session", version: 3, id: "session" }));
  stream.line(
    JSON.stringify({
      type: "message_start",
      message: { role: "assistant", content: [] },
    }),
  );
  const output = stream.line(
    JSON.stringify({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Live output",
      },
    }),
  );
  assert.deepEqual(
    read(lines(...output)).map((entry) => entry.text),
    ["Live output"],
  );
});

await test("CLV-364 transcript replacements survive incremental reads and keep advancing cursors", () => {
  const first = {
    ...assistant({ type: "text", text: "Partial" }),
    replaceId: "pi:message:1:0",
  };
  const final = {
    ...assistant({ type: "text", text: "Final" }),
    replaceId: first.replaceId,
  };
  const source = { open: true, attempts: [], prompts: [], privateTexts: [] };
  const partial = transcriptAppended(emptyTranscript, {
    ...source,
    text: lines(first),
  });
  assert.deepEqual(
    partial.entries.map((entry) => entry.text),
    ["Partial"],
  );
  const complete = transcriptAppended(partial, {
    ...source,
    text: lines(final),
  });
  assert.deepEqual(
    complete.entries.map((entry) => entry.text),
    ["Final"],
  );
  assert.equal(complete.bytes, Buffer.byteLength(lines(first, final)));
  assert.deepEqual(
    transcriptPage(complete.entries, { after: 1 }).entries.map((entry) => [
      entry.position,
      entry.text,
    ]),
    [[2, "Final"]],
  );
  assert.equal(transcriptPage(complete.entries, { after: 1 }).nextAfter, 2);
  assert.deepEqual(
    read(lines(first, "", first, final))
      .filter((entry) => entry.kind === "assistant")
      .map((entry) => [entry.attempt, entry.text]),
    [
      [1, "Partial"],
      [2, "Final"],
    ],
  );
});

await test("CLV-364 removed partial blocks disappear from a transcript but reach subscribers", () => {
  const first = {
    ...assistant({ type: "thinking", thinking: "Discarded" }),
    replaceId: "pi:message:1:1",
  };
  const removed = { type: "transcript_remove", replaceId: first.replaceId };
  const source = {
    open: false,
    attempts: [],
    prompts: [],
    privateTexts: [],
    text: lines(first, removed),
  };
  const complete = transcriptAppended(emptyTranscript, source);
  assert.deepEqual(read(source.text), []);
  const page = transcriptPage(complete.entries, { after: 1 });
  assert.equal(page.nextAfter, 2);
  assert.equal(Reflect.get(page.entries[0] ?? {}, "removed"), true);
});

await test("CLV-364 an unfinished Pi delta cannot reuse an earlier successful assistant", () => {
  const stream = piStream();
  const events = [
    ...piEvents().slice(0, -1),
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Unfinished",
      },
    },
    { type: "agent_settled", aborted: false },
  ];
  for (const event of events) stream.line(JSON.stringify(event));
  const result = resultOf(stream.result(0));
  assert.equal(result["is_error"], true);
  assert.match(String(result["result"]), /incomplete assistant/);
});

await test("CLV-364 Pi block ends replace deltas, blank blocks clear and new responses have distinct identities", () => {
  const activity = piActivity();
  const update = (event: Readonly<Record<string, unknown>>) =>
    activity.update({ assistantMessageEvent: event });
  const output = [
    ...activity.start({
      content: [null, { type: "toolCall" }, { type: "text", text: "Seed" }],
    }),
    ...update({ type: "text_delta", contentIndex: 2, delta: " delta" }),
    ...update({ type: "text_end", contentIndex: 2, content: "Block complete" }),
  ];
  assert.deepEqual(
    read(lines(...output)).map((entry) => entry.text),
    ["Block complete"],
  );
  output.push(...update({ type: "text_start", contentIndex: 2 }));
  assert.deepEqual(read(lines(...output)), []);
  output.push(
    ...update({ type: "thinking_start", contentIndex: 0 }),
    ...update({ type: "thinking_delta", contentIndex: 0, delta: "Plan" }),
    ...update({ type: "thinking_end", contentIndex: 0, content: "Checked" }),
  );
  assert.deepEqual(
    read(lines(...output)).map((entry) => [entry.kind, entry.text]),
    [["thinking", "Checked"]],
  );
  output.push(
    ...activity.completed({ content: [{ type: "thinking", redacted: true }] }),
  );
  assert.deepEqual(read(lines(...output)), []);
  output.push(
    ...update({ type: "text_end", contentIndex: 0, content: "Next response" }),
    ...activity.completed({ content: [{ type: "text", text: "Final" }] }),
  );
  assert.deepEqual(
    read(lines(...output)).map((entry) => entry.text),
    ["Final"],
  );
  assert.deepEqual(activity.start({}), []);
  assert.deepEqual(activity.completed({}), []);
  assert.deepEqual(activity.update({}), []);
  assert.deepEqual(
    update({ type: "toolcall_delta", contentIndex: 0, delta: "{}" }),
    [],
  );
});

await test("CLV-364 Pi delta journals stay linear in streamed content", () => {
  const activity = piActivity();
  activity.start({ content: [] });
  let bytes = 0;
  for (let index = 0; index < 2000; index += 1) {
    const output = activity.update({
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "x",
      },
    });
    bytes += output.reduce((size, line) => size + Buffer.byteLength(line), 0);
  }
  assert.ok(
    bytes < 400_000,
    `${String(bytes)} journal bytes for 2000 content bytes`,
  );
});

await test("CLV-364 completed Pi blocks follow authoritative content order", () => {
  const activity = piActivity();
  activity.start({ content: [] });
  const output = [
    ...activity.update({
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "Second draft",
      },
    }),
    ...activity.update({
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "First draft",
      },
    }),
    ...activity.completed({
      content: [
        { type: "text", text: "First" },
        { type: "text", text: "Second" },
      ],
    }),
  ];
  assert.deepEqual(
    read(lines(...output)).map((entry) => entry.text),
    ["First", "Second"],
  );
});

await test("CLV-364 incremental delta reads mask joined private text and release partial buffers on completion", () => {
  const delta = (text: string) => ({
    type: "transcript_delta",
    replaceId: "pi:message:1:0",
    kind: "assistant",
    delta: text,
  });
  const source = {
    open: true,
    attempts: [],
    prompts: [],
    privateTexts: ["private value"],
  };
  const first = transcriptAppended(emptyTranscript, {
    ...source,
    text: lines(delta("A private ")),
  });
  const next = transcriptAppended(first, {
    ...source,
    text: lines(delta("value here")),
  });
  assert.deepEqual(
    next.entries.map((entry) => entry.text),
    ["A [hidden] here"],
  );
  const final = {
    ...assistant({ type: "text", text: "Checked" }),
    replaceId: "pi:message:1:0",
  };
  const complete = transcriptAppended(next, { ...source, text: lines(final) });
  assert.deepEqual(
    complete.entries.map((entry) => entry.text),
    ["Checked"],
  );
  assert.equal(complete.partials, undefined);
  const restarted = transcriptAppended(next, {
    ...source,
    text: lines("", delta("New attempt")),
  });
  assert.deepEqual(
    restarted.partials?.map((partial) => partial.text),
    ["New attempt"],
  );
});
