import assert from "node:assert/strict";
import { test } from "node:test";
import { startMcp, request } from "./mcp-fixture.ts";
import { fields } from "./service-fixture.ts";

const cases = [
  ["invalid JSON", "{broken", -32700, null],
  ["oversized line", "x".repeat(1_048_577), -32600, null],
  [
    "oversized Unicode line",
    JSON.stringify({ text: "é".repeat(524_289) }),
    -32600,
    null,
  ],
  [
    "unknown method",
    JSON.stringify(request({ id: 1, method: "other" })),
    -32601,
    1,
  ],
  [
    "unknown tool",
    JSON.stringify(
      request({
        id: 1,
        method: "tools/call",
        params: { name: "cloving_watch" },
      }),
    ),
    -32602,
    1,
  ],
  [
    "unknown argument",
    JSON.stringify(
      request({
        id: 1,
        method: "tools/call",
        params: {
          name: "cloving_status",
          arguments: { surprise: true },
        },
      }),
    ),
    -32602,
    1,
  ],
  [
    "repository override",
    JSON.stringify(
      request({
        id: 1,
        method: "tools/call",
        params: {
          name: "cloving_status",
          arguments: { repository: "other" },
        },
      }),
    ),
    -32602,
    1,
  ],
  [
    "runtime override",
    JSON.stringify(
      request({
        id: 1,
        method: "tools/call",
        params: {
          name: "cloving_status",
          arguments: { runtimeDirectory: "other" },
        },
      }),
    ),
    -32602,
    1,
  ],
  [
    "socket override",
    JSON.stringify(
      request({
        id: 1,
        method: "tools/call",
        params: {
          name: "cloving_events",
          arguments: { socket: "other" },
        },
      }),
    ),
    -32602,
    1,
  ],
  [
    "follow mode",
    JSON.stringify(
      request({
        id: 1,
        method: "tools/call",
        params: {
          name: "cloving_events",
          arguments: { follow: true },
        },
      }),
    ),
    -32602,
    1,
  ],
  ["non-object", "null", -32600, null],
  ["batch", "[]", -32600, null],
  [
    "wrong protocol",
    JSON.stringify({ ...request({ id: 1, method: "ping" }), jsonrpc: "1.0" }),
    -32600,
    1,
  ],
  [
    "invalid id",
    JSON.stringify(request({ id: 1, method: "ping" })).replace(
      '"id":1',
      '"id":{}',
    ),
    -32600,
    null,
  ],
  ["no method", JSON.stringify({ jsonrpc: "2.0", id: 1 }), -32600, 1],
  [
    "invalid params",
    JSON.stringify(request({ id: 1, method: "ping", params: [] })),
    -32602,
    1,
  ],
] as const;

for (const [name, line, code, id] of cases)
  await test(`CLV-250 mcp recovers after ${name}`, async () => {
    const server = startMcp();
    server.line(line);
    server.send(request({ id: 2, method: "ping" }));
    const output = await server.end();
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stderr, "");
    assert.equal(server.messages.length, 2);
    const first = fields(server.messages[0]);
    assert.equal(fields(first["error"])["code"], code);
    assert.equal(first["id"], id);
    assert.equal(first["jsonrpc"], "2.0");
    assert.deepEqual(server.messages[1], { jsonrpc: "2.0", id: 2, result: {} });
  });

const decided = {
  reference: "run-1/design-1",
  expectedRevision: 1,
  generation: 1,
  subjectDigest: `sha256:${"0".repeat(64)}`,
  commandId: "c",
};
const commanded = { runId: "run-1", expectedRevision: 1, commandId: "c" };
const decisionTools = [
  ["cloving_answer", { ...decided, text: "yes" }],
  ["cloving_approve", decided],
  ["cloving_deny", { ...decided, text: "no" }],
] as const;
const runCommandTools = ["pause", "resume", "drop"].map(
  (command) => [`cloving_${command}`, commanded] as const,
);

function without(values: Readonly<Record<string, unknown>>, name: string) {
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => key !== name),
  );
}

const mutationArguments = [
  ...[...decisionTools, ...runCommandTools].map(([name, values]) => ({
    name,
    arguments: without(values, "commandId"),
  })),
  { name: "cloving_answer", arguments: decided },
  { name: "cloving_approve", arguments: { ...decided, text: "yes" } },
  ...decisionTools.flatMap(([name, values]) =>
    [
      { expectedRevision: 0 },
      { expectedRevision: 1.5 },
      { expectedRevision: "1" },
      { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { generation: 0 },
      { generation: -1 },
      { subjectDigest: "sha256:abc" },
      { subjectDigest: `sha256:${"A".repeat(64)}` },
      { reference: "" },
      { reference: "a b" },
      { reference: "r".repeat(257) },
      ...(name === "cloving_approve" ? [] : [{ text: " " }, { text: 1 }]),
    ].map((change) => ({ name, arguments: { ...values, ...change } })),
  ),
  ...runCommandTools.flatMap(([name, values]) =>
    [
      { runId: "constructor" },
      { runId: "" },
      { expectedRevision: 0 },
      { expectedRevision: "2" },
      { reference: "run-1/design-1" },
    ].map((change) => ({ name, arguments: { ...values, ...change } })),
  ),
];

const invalid = [
  { name: "cloving_status", arguments: [] },
  { name: "cloving_status", arguments: null },
  { name: "cloving_questions", arguments: { runId: "" } },
  { name: "cloving_questions", arguments: { runId: 1 } },
  { name: "cloving_questions", arguments: { runId: "constructor" } },
  { name: "cloving_status", arguments: { after: 2 } },
  { name: "cloving_status", arguments: { limit: "1" } },
  { name: "cloving_status", arguments: { limit: 0 } },
  { name: "cloving_status", arguments: { limit: 501 } },
  { name: "cloving_events", arguments: { limit: 1001 } },
  { name: "cloving_events", arguments: { after: -1 } },
  { name: "cloving_events", arguments: { after: 0.1 } },
  {
    name: "cloving_events",
    arguments: { after: Number.MAX_SAFE_INTEGER + 1 },
  },
  { name: "cloving_events", arguments: { after: "0" } },
  { arguments: {} },
  { name: "cloving_run", arguments: { workflowId: "develop", prompt: "x" } },
  { name: "cloving_run", arguments: { prompt: "x", commandId: "c" } },
  {
    name: "cloving_run",
    arguments: { workflowId: "develop", commandId: "c" },
  },
  {
    name: "cloving_run",
    arguments: {
      workflowId: "develop",
      prompt: "x",
      ticket: "42",
      commandId: "c",
    },
  },
  {
    name: "cloving_run",
    arguments: {
      workflowId: "develop",
      ticket: "42",
      input: { ticket: "42" },
      commandId: "c",
    },
  },
  ...[[], "input.json", null, 1].map((input) => ({
    name: "cloving_run",
    arguments: { workflowId: "develop", input, commandId: "c" },
  })),
  ...[" \n", 1].map((prompt) => ({
    name: "cloving_run",
    arguments: { workflowId: "develop", prompt, commandId: "c" },
  })),
  ...["constructor", "bad!id", 42].map((ticket) => ({
    name: "cloving_run",
    arguments: { workflowId: "develop", ticket, commandId: "c" },
  })),
  ...["", "bad id", 7].map((workflowId) => ({
    name: "cloving_run",
    arguments: { workflowId, prompt: "x", commandId: "c" },
  })),
  ...["", "__proto__", "c".repeat(129), 7].map((commandId) => ({
    name: "cloving_run",
    arguments: { workflowId: "develop", prompt: "x", commandId },
  })),
  ...mutationArguments,
];

await test("CLV-250 mcp rejects invalid argument types and bounds without calling the service", async () => {
  const server = startMcp();
  for (const [index, params] of invalid.entries())
    server.send(request({ id: index, method: "tools/call", params: params }));
  server.send(request({ id: "next", method: "ping" }));
  const output = await server.end();
  assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(
    server.messages
      .slice(0, -1)
      .map((message) => fields(message["error"])["code"]),
    invalid.map(() => -32602),
  );
  assert.deepEqual(server.messages.at(-1), {
    jsonrpc: "2.0",
    id: "next",
    result: {},
  });
});

await test("CLV-250 mcp accepts a one MiB line and ignores requestless notifications", async () => {
  const server = startMcp();
  const line = JSON.stringify(request({ id: 1, method: "ping" }));
  server.line(line + " ".repeat(1_048_576 - Buffer.byteLength(line)));
  server.send({ jsonrpc: "2.0", method: "unknown/notification" });
  server.send({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "cloving_run" },
  });
  const output = await server.end();
  assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(server.messages, [{ jsonrpc: "2.0", id: 1, result: {} }]);
});

await test("CLV-251 the valid mutation arguments of the rejection cases reach the service", async () => {
  const server = startMcp();
  const valid = [
    ...decisionTools,
    ...runCommandTools,
    ["cloving_run", { workflowId: "develop", ticket: "next", commandId: "c" }],
  ] as const;
  for (const [index, [name, values]] of valid.entries())
    server.send(
      request({
        id: index,
        method: "tools/call",
        params: { name, arguments: values },
      }),
    );
  const output = await server.end();
  assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(
    server.messages.map((message) => {
      const result = fields(message["result"]);
      return [
        result["isError"],
        fields(result["structuredContent"])["code"],
        fields(result["structuredContent"])["commandId"],
      ];
    }),
    valid.map(() => [true, "service-unavailable", "c"]),
  );
});
