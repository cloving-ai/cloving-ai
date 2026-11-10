import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseInvocation } from "../src/cli/arguments.ts";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { commandUsage } from "../src/cli/usage.ts";
import {
  removeWorkspaceRecord,
  workspaceRecordPath,
  writeWorkspaceRecord,
} from "../src/cli/workspace-record.ts";
import type { Fields } from "../src/protocol.ts";
import {
  approval,
  approvalRun,
  channelServer,
  channelService,
  type ChannelService,
} from "./mcp-channel-fixture.ts";
import { request, startMcp } from "./mcp-fixture.ts";
import { fields } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const root = realpathSync(
  mkdtempSync(join(tmpdir(), "clv-mcp-workspace-channel-")),
);
process.on("exit", () => {
  rmSync(root, { recursive: true, force: true });
});

const environment: NodeJS.ProcessEnv = {
  CLOVING_RUNTIME_DIR: undefined,
  CLOVING_PRIVATE_TEXTS: undefined,
  XDG_STATE_HOME: join(root, "state"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_RUNTIME_DIR: "",
};

interface Member {
  readonly name: string;
  readonly runtime: string;
  readonly service: ChannelService;
}

async function member(name: string): Promise<Member> {
  const runtime = join(root, `${name}-run`);
  await mkdir(runtime, { recursive: true });
  return { name, runtime, service: await channelService(runtime) };
}

async function recordedWorkspace(names: readonly string[]): Promise<string> {
  for (const name of names) await mkdir(join(root, name), { recursive: true });
  const path = String(workspaceRecordPath(environment));
  await writeWorkspaceRecord(path, {
    processId: process.pid,
    members: names.map((name) => ({
      name,
      repository: join(root, name),
      runtime: join(root, `${name}-run`),
    })),
  });
  return path;
}

async function privateTexts(name: string, texts: readonly string[]) {
  const settings = privateSettingsPath(environment, join(root, name));
  await mkdir(dirname(settings), { recursive: true });
  await writeFile(
    settings,
    JSON.stringify({ version: 1, privateTexts: texts }),
  );
}

const pausedRun = {
  runId: "run-paused0000",
  workflowId: "develop",
  state: "paused",
  title: "Alpha Secret work",
  reason: { code: "paused", detail: "The operator paused the run." },
};

const pausedMessage = {
  content:
    "Run run-paus… ([hidden] work) is paused: The operator paused the run. Resume it with cloving_resume, or drop it with cloving_drop.",
  meta: {
    run_id: pausedRun.runId,
    kind: "paused",
    workflow: "develop",
    repository: "alpha",
  },
};

function sentBy(messages: readonly Fields[], name: string): Fields {
  return fields(
    messages.find((message) => fields(message["meta"])["repository"] === name),
  );
}

await test("CLV-338 the workspace MCP server with the channel option tells the alerts of each repository with the repository name", async () => {
  const members = await Promise.all(["alpha", "beta"].map(member));
  const [alpha, beta] = members;
  assert.ok(alpha && beta);
  const path = await recordedWorkspace(["alpha", "beta"]);
  await privateTexts("alpha", ["Alpha Secret"]);
  const server = await channelServer({
    runtime: alpha.runtime,
    directory: root,
    environment,
    argumentsList: ["--workspace", "--channel"],
  });
  try {
    beta.service.run(approvalRun, "run.started");
    beta.service.decide(approval);
    alpha.service.run(pausedRun, "run.paused");
    const sent = await server.sent(2);
    await delay(testMilliseconds(300));
    const output = await server.end();
    assert.equal(output.status, 0, output.stderr);
    const result = fields(server.messages[0]?.["result"]);
    assert.deepEqual(result["capabilities"], {
      tools: {},
      experimental: { "claude/channel": {} },
    });
    assert.match(String(result["instructions"]), /repository argument/);
    assert.equal(server.channel().length, 2);
    assert.deepEqual(fields(sentBy(sent, "beta")["meta"]), {
      run_id: approvalRun.runId,
      kind: "decision",
      workflow: "develop",
      ticket: "CLV-336",
      decision_id: approval.decisionId,
      repository: "beta",
    });
    assert.deepEqual(sentBy(sent, "alpha"), pausedMessage);
    for (const { runtime } of members)
      assert.ok(await stat(join(runtime, "channel-events.json")));
  } finally {
    server.child.kill();
    await removeWorkspaceRecord(path, process.pid);
    for (const { service } of members) await service.close();
  }
});

await test("CLV-338 the workspace MCP server with the channel option refuses private texts that are not a list of texts", async () => {
  const path = await recordedWorkspace(["gamma"]);
  try {
    const server = startMcp({
      argumentsList: ["--workspace", "--channel"],
      directory: root,
      environment: { ...environment, CLOVING_PRIVATE_TEXTS: '{"text": 1}' },
    });
    server.send(request({ id: 1, method: "ping" }));
    const output = await server.end();
    assert.equal(output.status, 2);
    assert.match(output.stderr, /^invalid-private-texts: /);
    assert.deepEqual(server.messages, []);
  } finally {
    await removeWorkspaceRecord(path, process.pid);
  }
});

await test("CLV-338 mcp parses the channel option with a workspace, and the help and the README name it", async () => {
  assert.deepEqual(parseInvocation(["mcp", "--workspace", "--channel"]), {
    kind: "mcp",
    channel: true,
    workspace: true,
  });
  assert.match(
    String(commandUsage["mcp"]),
    /^ {7}cloving mcp --workspace \[--channel\]$/m,
  );
  const section =
    (await readFile("README.md", "utf8"))
      .split("### Get alerts in Claude Code\n")[1]
      ?.split(/^#{2,3} /m)[0] ?? "";
  assert.ok(section.includes("cloving mcp --workspace --channel"));
  assert.ok(section.includes("`repository` attribute"));
});
