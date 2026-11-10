import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import { request, startMcp } from "./mcp-fixture.ts";
import { fields, withHarness } from "./service-fixture.ts";

async function initialized(
  argumentsList: readonly string[],
  protocolVersion: string,
) {
  const server = startMcp({ argumentsList });
  server.send(
    request({
      id: 1,
      method: "initialize",
      params: { protocolVersion, capabilities: {} },
    }),
  );
  const output = await server.end();
  assert.equal(output.status, 0, output.stderr);
  return fields(server.messages[0]?.["result"]);
}

await test("CLV-338 mcp parses the channel option with a repository", () => {
  assert.deepEqual(parseInvocation(["mcp", "--channel"]), {
    kind: "mcp",
    channel: true,
  });
  assert.deepEqual(
    parseInvocation(["mcp", "--repository", "project", "--channel"]),
    { kind: "mcp", repository: "project", channel: true },
  );
});

await test("CLV-338 mcp with the channel option declares the channel beside tools and gives instructions", async () => {
  const result = await initialized(["--channel"], "2025-11-25");
  assert.deepEqual(result["capabilities"], {
    tools: {},
    experimental: { "claude/channel": {} },
  });
  const instructions = String(result["instructions"]);
  assert.match(instructions, /channel message/);
  for (const tool of [
    "cloving_questions",
    "cloving_answer",
    "cloving_approve",
    "cloving_deny",
    "cloving_resume",
    "cloving_continue",
    "cloving_dismiss",
  ])
    assert.ok(instructions.includes(tool), tool);
});

await test("CLV-338 mcp without the channel option declares only tools and gives no instructions", async () => {
  const result = await initialized([], "2025-11-25");
  assert.deepEqual(result["capabilities"], { tools: {} });
  assert.equal(Object.hasOwn(result, "instructions"), false);
});

await test("CLV-338 mcp with the channel option answers the newest Claude Code revision with an earlier one", async () => {
  const result = await initialized(["--channel"], "2026-07-28");
  assert.equal(result["protocolVersion"], "2025-11-25");
  assert.deepEqual(result["capabilities"], {
    tools: {},
    experimental: { "claude/channel": {} },
  });
  const server = startMcp({ argumentsList: ["--channel"] });
  server.send(
    request({
      id: "discover",
      method: "server/discover",
      params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      },
    }),
  );
  const output = await server.end();
  assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(server.messages, [
    {
      jsonrpc: "2.0",
      id: "discover",
      error: { code: -32601, message: "Method not found." },
    },
  ]);
});

await test("CLV-338 mcp help documents the channel option", () =>
  withHarness(async (harness) => {
    const help = await harness.cli(["mcp", "--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(
      help.stdout,
      /Usage: cloving mcp \[--repository <directory>\] \[--channel\]/,
    );
    assert.match(help.stdout, /--channel .*Claude Code.*needs you/s);
  }));

await test("CLV-338 the README explains the channel setup, the revision and the limits of the research preview", async () => {
  const section =
    (await readFile("README.md", "utf8"))
      .split("### Get alerts in Claude Code\n")[1]
      ?.split(/^#{2,3} /m)[0] ?? "";
  for (const fact of [
    'claude mcp add --scope local --transport stdio cloving-local -- cloving mcp --repository "$PWD" --channel',
    "claude --dangerously-load-development-channels server:cloving-local",
    "`2026-07-28`",
    "`2025-11-25`",
    "interactive session",
    "confirmation dialog",
    "Team and Enterprise",
    "no desktop alert",
    "`CLOVING_NOTIFY_COMMAND`",
  ])
    assert.ok(section.includes(fact), fact);
});
