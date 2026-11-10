import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { mcpExchange, request } from "./mcp-fixture.ts";
import { fields, items } from "./service-fixture.ts";

await test("CLV-250 mcp initializes over stdio", async () => {
  const output = await mcpExchange([
    request({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    }),
  ]);
  assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(output.messages, [
    {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: {
          name: "cloving",
          version: fields(
            JSON.parse(
              await readFile(
                new URL("../package.json", import.meta.url),
                "utf8",
              ),
            ),
          )["version"],
        },
      },
    },
  ]);
});

const binding = [
  "expectedRevision",
  "generation",
  "subjectDigest",
  "commandId",
];
const mutation = { readOnlyHint: false, idempotentHint: true };
const listed = [
  ["cloving_status", ["runId", "limit", "after"], undefined],
  ["cloving_questions", ["runId"], undefined],
  ["cloving_events", ["runId", "after", "limit"], undefined],
  [
    "cloving_run",
    ["workflowId", "prompt", "ticket", "input", "commandId"],
    ["workflowId", "commandId"],
  ],
  [
    "cloving_answer",
    ["reference", "text", ...binding],
    ["reference", "text", ...binding],
  ],
  ["cloving_approve", ["reference", ...binding], ["reference", ...binding]],
  [
    "cloving_deny",
    ["reference", "text", ...binding],
    ["reference", ...binding],
  ],
  ...["pause", "resume", "drop"].map((command) => [
    `cloving_${command}`,
    ["runId", "expectedRevision", "commandId"],
    ["runId", "expectedRevision", "commandId"],
  ]),
  [
    "cloving_continue",
    ["runId", "from", "bundle", "note", "commandId"],
    ["runId", "commandId"],
  ],
  ["cloving_dismiss", ["runId", "commandId"], ["runId", "commandId"]],
  [
    "cloving_steer",
    ["runId", "text", "now", "commandId"],
    ["runId", "text", "commandId"],
  ],
  [
    "cloving_rename",
    ["runId", "title", "label", "clear", "commandId"],
    ["runId", "commandId"],
  ],
  ["cloving_schedules", [], undefined],
  ["cloving_schedule_pause", ["workflowId"], ["workflowId"]],
  ["cloving_schedule_resume", ["workflowId"], ["workflowId"]],
  [
    "cloving_schedule_run",
    ["workflowId", "commandId"],
    ["workflowId", "commandId"],
  ],
] as const;
const reads = [
  "cloving_status",
  "cloving_questions",
  "cloving_events",
  "cloving_schedules",
];

await test("CLV-251 CLV-328 mcp handshake lists the four read tools and the twelve mutation tools and answers ping", async () => {
  const output = await mcpExchange([
    request({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }),
    { jsonrpc: "2.0", method: "notifications/initialized" },
    request({ id: "ping", method: "ping" }),
    request({ id: 3, method: "tools/list" }),
  ]);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stderr, "");
  assert.deepEqual(
    output.messages.map((message) => message["id"]),
    [1, "ping", 3],
  );
  assert.deepEqual(output.messages[1], {
    jsonrpc: "2.0",
    id: "ping",
    result: {},
  });
  const tools = items(fields(output.messages[2]?.["result"])["tools"]).map(
    fields,
  );
  assert.deepEqual(
    tools.map((tool) => [
      tool["name"],
      Object.keys(fields(fields(tool["inputSchema"])["properties"])),
      fields(tool["inputSchema"])["required"],
    ]),
    listed,
  );
  for (const tool of tools) {
    const reading = reads.includes(String(tool["name"]));
    assert.deepEqual(
      tool["annotations"],
      reading
        ? { readOnlyHint: true }
        : {
            ...mutation,
            ...(tool["name"] === "cloving_drop"
              ? { destructiveHint: true }
              : {}),
          },
    );
    assert.equal(
      typeof tool["description"],
      reads.slice(0, 3).includes(String(tool["name"])) ? "undefined" : "string",
    );
    assert.equal(fields(tool["inputSchema"])["type"], "object");
    assert.equal(fields(tool["inputSchema"])["additionalProperties"], false);
  }
  assert.match(
    String(tools[3]?.["description"]),
    /exactly one of prompt, ticket and input.*same commandId/s,
  );
});

for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-01-01"])
  await test(`CLV-250 mcp negotiates ${version}`, async () => {
    const output = await mcpExchange([
      request({
        id: 1,
        method: "initialize",
        params: { protocolVersion: version },
      }),
    ]);
    assert.equal(output.status, 0, output.stderr);
    assert.equal(
      fields(output.messages[0]?.["result"])["protocolVersion"],
      version === "2024-01-01" ? "2025-11-25" : version,
    );
  });

for (const version of [["2025-06-18"], { toString: "unexpected" }])
  await test("CLV-250 mcp negotiates a string version after malformed version input", async () => {
    const output = await mcpExchange([
      request({
        id: 1,
        method: "initialize",
        params: { protocolVersion: version },
      }),
      request({ id: 2, method: "ping" }),
    ]);
    assert.equal(output.status, 0, output.stderr);
    assert.equal(
      fields(output.messages[0]?.["result"])["protocolVersion"],
      "2025-11-25",
    );
    assert.deepEqual(output.messages[1], { jsonrpc: "2.0", id: 2, result: {} });
  });
