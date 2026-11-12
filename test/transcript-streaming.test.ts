import assert from "node:assert/strict";
import { test } from "node:test";
import { piStream } from "../src/daemon/pi-stream.ts";
import { emptyTranscript, transcriptAppended } from "../src/turn-transcript.ts";
import { assistant, lines, toolResult } from "./turn-transcript-fixture.ts";

const source = {
  open: true,
  attempts: [],
  prompts: [],
  privateTexts: ["customer-password"],
};

const delta = (text: string) => ({
  type: "transcript_delta",
  replaceId: "pi:message:1:0",
  kind: "assistant",
  delta: text,
});

await test("CLV-364 Pi growing tool results withhold private prefixes on every live read", () => {
  for (const value of [
    "customer-password",
    "CUSTOMER-password",
    "ghp_secret",
  ]) {
    const stream = piStream();
    stream.line(JSON.stringify({ type: "session", version: 3, id: "session" }));
    let parsed = emptyTranscript;
    let journal = "";
    for (let length = 1; length <= value.length; length += 1) {
      const output = stream.line(
        JSON.stringify({
          type: "tool_execution_update",
          toolCallId: "call-1",
          toolName: "bash",
          args: {},
          partialResult: {
            content: [{ type: "text", text: `Safe ${value.slice(0, length)}` }],
          },
        }),
      );
      const text = output.join("\n") + "\n";
      journal += text;
      parsed = transcriptAppended(parsed, { ...source, text });
      assert.equal(parsed.entries.length, 1);
      assert.equal(parsed.entries[0]?.kind, "tool-result");
      assert.ok(
        ["Safe ", "Safe [hidden]"].includes(parsed.entries[0].text),
        parsed.entries[0].text,
      );
      assert.deepEqual(
        transcriptAppended(emptyTranscript, { ...source, text: journal }),
        parsed,
      );
    }
    const completed = stream.line(
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        args: {},
        result: { content: [{ type: "text", text: "Safe customer-passwor" }] },
        isError: false,
      }),
    );
    parsed = transcriptAppended(parsed, {
      ...source,
      text: lines(...completed),
    });
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0]?.text, "Safe customer-passwor");
    assert.equal(parsed.partials, undefined);
  }
});

await test("CLV-364 every live read withholds unfinished private values and token prefixes", () => {
  for (const value of [
    "customer-password",
    "CUSTOMER-password",
    "ghp_secret",
  ]) {
    let parsed = emptyTranscript;
    for (const letter of `Safe ${value}`) {
      parsed = transcriptAppended(parsed, {
        ...source,
        text: lines(delta(letter)),
      });
      const shown = parsed.entries.at(-1)?.text ?? "";
      assert.ok(
        ["Safe ", "Safe [hidden]", "S", "Sa", "Saf", "Safe"].includes(shown),
        shown,
      );
    }
    parsed = transcriptAppended(parsed, {
      ...source,
      text: lines(delta(" done")),
    });
    assert.equal(parsed.entries.at(-1)?.text, "Safe [hidden] done");
  }
});

await test("CLV-364 partial snapshots mask private suffixes after removing controls", () => {
  for (const draft of [
    assistant({ type: "text", text: "Safe CUSTOMER-\u001b[31mpasswor" }),
    toolResult("Safe CUSTOMER-\u001b[31mpasswor"),
  ]) {
    const parsed = transcriptAppended(emptyTranscript, {
      ...source,
      text: lines({ ...draft, replaceId: "block", partial: true }),
    });
    assert.equal(parsed.entries[0]?.text, "Safe ");
  }
  const completed = transcriptAppended(emptyTranscript, {
    ...source,
    text: lines(assistant({ type: "text", text: "Safe customer-passwor" })),
  });
  assert.equal(completed.entries[0]?.text, "Safe customer-passwor");
});

await test("CLV-364 private replacement keys stay distinct through updates, removals and replay", () => {
  const block = (id: string, text: string) => ({
    ...assistant({ type: "text", text }),
    replaceId: `pi:message:1:${id}`,
  });
  const input = { ...source, privateTexts: ["1", "2"] };
  const first = transcriptAppended(emptyTranscript, {
    ...input,
    text: lines(block("1", "First"), block("2", "Second")),
  });
  assert.deepEqual(
    first.entries.map((entry) => entry.text),
    ["First", "Second"],
  );
  const ids = first.entries.map((entry) => entry.replaceId);
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.every((id) => !id?.includes("pi:message")));
  const tail = lines(block("1", "Updated"), {
    type: "transcript_remove",
    replaceId: "pi:message:1:2",
  });
  const next = transcriptAppended(first, { ...input, text: tail });
  assert.deepEqual(
    next.entries.map((entry) => entry.replaceId),
    ids,
  );
  assert.equal(next.entries[0]?.text, "Updated");
  assert.equal(next.entries[1]?.removed, true);
  const replay = transcriptAppended(emptyTranscript, {
    ...input,
    text: lines(block("1", "First"), block("2", "Second")) + tail,
  });
  assert.deepEqual(replay, next);
});

await test("CLV-364 incremental long responses bound retained text and encoding work", () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    TextEncoder.prototype,
    "encode",
  );
  assert.ok(descriptor);
  const encode = TextEncoder.prototype.encode.bind(new TextEncoder());
  let encoded = 0;
  TextEncoder.prototype.encode = function (input = "") {
    encoded += input.length;
    return encode(input);
  };
  try {
    let parsed = emptyTranscript;
    for (let index = 0; index < 1500; index += 1)
      parsed = transcriptAppended(parsed, {
        ...source,
        text: lines(delta("x".repeat(128))),
      });
    assert.ok(encoded < 4_000_000, `${String(encoded)} characters encoded`);
    assert.equal(parsed.entries[0]?.text.length, 65_536);
    assert.equal(parsed.entries[0].omittedBytes, 192_000 - 65_536);
    assert.ok(JSON.stringify(parsed.partials).length < 66_000);
  } finally {
    Object.defineProperty(TextEncoder.prototype, "encode", descriptor);
  }
});

await test("CLV-364 split control sequences, Unicode and token continuations stay private", () => {
  let parsed = emptyTranscript;
  for (const chunk of [
    "Safe \u001b]hidden",
    " title\u001b",
    "\\",
    "customer-",
    "passwor",
    "d gh",
    "p_abc",
    "def",
    " \ud83d",
    "\udc08 done",
  ]) {
    parsed = transcriptAppended(parsed, {
      ...source,
      text: lines(delta(chunk)),
    });
    assert.ok(!parsed.entries[0]?.text.includes("hidden title"));
    assert.ok(!parsed.entries[0]?.text.includes("abcdef"));
  }
  assert.equal(parsed.entries[0]?.text, "Safe [hidden] [hidden] 🐈 done");
});

await test("CLV-364 overlapping private values stay buffered until the longer match is known", () => {
  let parsed = emptyTranscript;
  for (const chunk of ["customer-pass", "wor"]) {
    parsed = transcriptAppended(parsed, {
      ...source,
      privateTexts: ["customer-pass", "customer-password"],
      text: lines(delta(chunk)),
    });
    assert.equal(parsed.entries[0]?.text, "");
  }
  parsed = transcriptAppended(parsed, { ...source, text: lines(delta("d")) });
  assert.equal(parsed.entries[0]?.text, "[hidden]");
});

await test("CLV-364 truncation keeps a continuous UTF-8 prefix across later deltas", () => {
  let parsed = emptyTranscript;
  for (const chunk of ["x".repeat(65_535), "🐈", "z"])
    parsed = transcriptAppended(parsed, {
      ...source,
      text: lines(delta(chunk)),
    });
  assert.equal(parsed.entries[0]?.text, "x".repeat(65_535));
  assert.equal(parsed.entries[0].omittedBytes, 5);
});

await test("CLV-364 every non-ASCII private prefix uses the complete-mask case semantics", () => {
  for (const [privateText, value] of [
    ["İsecret", "İsecret"],
    ["σsecret", "ςsecret"],
  ]) {
    assert.ok(privateText !== undefined && value !== undefined);
    let parsed = emptyTranscript;
    for (const character of value) {
      parsed = transcriptAppended(parsed, {
        ...source,
        privateTexts: [privateText],
        text: lines(delta(character)),
      });
      assert.ok(
        ["", "[hidden]"].includes(parsed.entries[0]?.text ?? ""),
        parsed.entries[0]?.text ?? "",
      );
    }
    assert.equal(parsed.entries[0]?.text, "[hidden]");
  }
});

await test("CLV-364 partial sanitization spans terminal controls without retaining hidden payloads", () => {
  let parsed = emptyTranscript;
  for (const chunk of [
    "A\u001b",
    "(B",
    "B\u001b[",
    "31mC\u001b]",
    "hidden".repeat(20_000),
    "\u0007D\u001b[",
    "\u0000E\u0080\rF",
  ]) {
    parsed = transcriptAppended(parsed, {
      ...source,
      text: lines(delta(chunk)),
    });
    assert.ok(JSON.stringify(parsed.partials).length < 1000);
  }
  assert.equal(parsed.entries[0]?.text, "ABCDEF");
});
