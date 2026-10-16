import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTranscript } from "../src/chats/normalize.ts";

const first = JSON.stringify({ type: "progress", data: "omitted" });
const second = JSON.stringify({
  type: "user",
  timestamp: "2026-10-16T00:00:00Z",
  sessionId: "session",
  message: { role: "user", content: "café 🐈" },
});
const third = JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "first" },
      {
        type: "tool_use",
        id: "call",
        name: "Shell",
        input: { command: "echo never", nested: [null, true, 3] },
      },
      { type: "text", text: "second" },
    ],
  },
});
const fourth = JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "call",
        content: [{ type: "text", text: "ok" }],
        is_error: false,
      },
      {
        type: "tool_result",
        tool_use_id: "failure",
        content: "failed",
        is_error: true,
      },
      { type: "tool_result", tool_use_id: "unspecified", content: "done" },
    ],
  },
});
const offset = (lines: string[]) =>
  Buffer.byteLength(lines.join("\r\n") + "\r\n");
const expected = {
  status: "included",
  reason: "supported",
  omissions: { metadataRecords: 1, thinkingBlocks: 1 },
  records: [
    {
      schemaVersion: 1,
      sourceId: `sha256:digest:${String(offset([first]))}`,
      role: "user",
      timestamp: "2026-10-16T00:00:00Z",
      sessionId: "session",
      text: "café 🐈",
      blocks: [{ position: 0, type: "text", text: "café 🐈" }],
    },
    {
      schemaVersion: 1,
      sourceId: `sha256:digest:${String(offset([first, second]))}`,
      role: "assistant",
      timestamp: null,
      sessionId: null,
      text: "first\nsecond",
      blocks: [
        { position: 1, type: "text", text: "first" },
        {
          position: 2,
          type: "tool_use",
          id: "call",
          name: "Shell",
          input: { command: "echo never", nested: [null, true, 3] },
        },
        { position: 3, type: "text", text: "second" },
      ],
    },
    {
      schemaVersion: 1,
      sourceId: `sha256:digest:${String(offset([first, second, third]))}`,
      role: "user",
      timestamp: null,
      sessionId: null,
      text: "",
      blocks: [
        {
          position: 0,
          type: "tool_result",
          tool_use_id: "call",
          content: [{ type: "text", text: "ok" }],
          is_error: false,
        },
        {
          position: 1,
          type: "tool_result",
          tool_use_id: "failure",
          content: "failed",
          is_error: true,
        },
        {
          position: 2,
          type: "tool_result",
          tool_use_id: "unspecified",
          content: "done",
        },
      ],
    },
  ],
};

await test("CLV-095 normalizes messages, tool fields, omissions and byte positions", () => {
  assert.deepEqual(
    normalizeTranscript(
      [first, second, third, fourth].join("\r\n"),
      "sha256:digest",
    ),
    expected,
  );
});

for (const [text, reason] of [
  ["", "empty-file"],
  ["{", "invalid-json"],
  ["\n", "invalid-json"],
  ["null", "unsupported-record"],
  ["{}", "unsupported-record"],
  [
    JSON.stringify({
      type: "future-message",
      message: { role: "user", content: "unknown envelope" },
    }),
    "unsupported-message",
  ],
  [
    JSON.stringify({
      type: "user",
      message: { role: "assistant", content: "x" },
    }),
    "unsupported-message",
  ],
  [
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: 3 },
    }),
    "unsupported-message",
  ],
  [
    JSON.stringify({
      type: "user",
      sessionId: 3,
      message: { role: "user", content: "x" },
    }),
    "unsupported-message",
  ],
  ...[
    { type: "image", source: "x" },
    { type: "text", text: 3 },
    { type: "tool_use", name: "Shell", input: {} },
    { type: "tool_use", id: "i", input: {} },
    { type: "tool_use", id: "i", name: "Shell" },
    { type: "tool_result", content: "x" },
    { type: "tool_result", tool_use_id: "i" },
    { type: "tool_result", tool_use_id: "i", content: "x", is_error: "yes" },
  ].map((block) => [
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [block] },
    }),
    "unsupported-block",
  ]),
] as const) {
  await test(`CLV-095 refuses ${reason}: ${text}`, () => {
    const valid = JSON.stringify({
      type: "user",
      message: { role: "user", content: "valid prefix" },
    });
    const result = normalizeTranscript(
      text === "" ? text : `${valid}\n${text}`,
      "sha256:digest",
    );
    assert.equal(result.status, "unsupported");
    assert.equal(result.reason, reason);
    assert.deepEqual(result.records, []);
  });
}

for (const number of [
  "1e400",
  "-1e400",
  "1e-400",
  "9007199254740993",
  "0.1234567890123456789",
  "-0",
]) {
  await test(`CLV-095 preserves JSON numeric token ${number} in tool inputs and results`, () => {
    const text = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"call","name":"tool","input":{"value":${number}}},{"type":"tool_result","tool_use_id":"call","content":{"value":${number}}}]}}`;
    const result = normalizeTranscript(text, "sha256:digest");
    assert.equal(result.status, "included");
    const serialized = JSON.stringify(result.records);
    assert.ok(serialized.includes(`"input":{"value":${number}}`));
    assert.ok(serialized.includes(`"content":{"value":${number}}`));
  });
}
