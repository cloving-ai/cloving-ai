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

await test("CLV-250 mcp handshake lists only the three read tools and answers ping", async () => {
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
    tools.map((tool) => tool["name"]),
    ["cloving_status", "cloving_questions", "cloving_events"],
  );
  for (const tool of tools) {
    assert.deepEqual(tool["annotations"], { readOnlyHint: true });
    assert.equal(fields(tool["inputSchema"])["type"], "object");
    assert.equal(fields(tool["inputSchema"])["additionalProperties"], false);
    assert.equal(fields(tool["inputSchema"])["required"], undefined);
  }
  assert.deepEqual(
    tools.map((tool) =>
      Object.keys(fields(fields(tool["inputSchema"])["properties"])),
    ),
    [["runId", "limit", "after"], ["runId"], ["runId", "after", "limit"]],
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
