import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  removeWorkspaceRecord,
  workspaceRecordPath,
  writeWorkspaceRecord,
} from "../src/cli/workspace-record.ts";
import type { Fields, ServiceRequest } from "../src/protocol.ts";
import { listen, type Listener } from "../src/service/transport.ts";
import { parseInvocation } from "../src/cli/arguments.ts";
import { commandUsage } from "../src/cli/usage.ts";
import { request, startMcp } from "./mcp-fixture.ts";
import { fields, items } from "./service-fixture.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "clv-mcp-workspace-")));
process.on("exit", () => {
  rmSync(root, { recursive: true, force: true });
});

const environment: NodeJS.ProcessEnv = {
  CLOVING_RUNTIME_DIR: undefined,
  XDG_STATE_HOME: join(root, "state"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_RUNTIME_DIR: "",
};

interface Member {
  readonly name: string;
  readonly requests: ServiceRequest[];
  readonly listener: Listener;
  readonly runtime: string;
}

async function member(name: string): Promise<Member> {
  const runtime = join(root, `${name}-run`);
  await mkdir(runtime, { recursive: true });
  const requests: ServiceRequest[] = [];
  const listener = await listen({
    path: join(runtime, "control.sock"),
    handle: (request) => {
      requests.push(request);
      if (request.operation === "run")
        return Promise.resolve({
          kind: "result",
          result: {
            kind: "run-admitted",
            runId: `run-${name}`,
            commandId: request.parameters["commandId"],
          },
        });
      if (request.operation === "questions")
        return Promise.resolve({
          kind: "result",
          result: { kind: "questions", decisions: [] },
        });
      return Promise.resolve({
        kind: "result",
        result: { kind: "run-list", runs: [], next: null },
      });
    },
  });
  return { name, requests, listener, runtime };
}

async function withWorkspace(
  names: readonly string[],
  body: (members: readonly Member[]) => Promise<void>,
): Promise<void> {
  const members = await Promise.all(names.map(member));
  const path = String(workspaceRecordPath(environment));
  await writeWorkspaceRecord(path, {
    processId: process.pid,
    members: members.map(({ name, runtime }) => ({
      name,
      repository: join(root, name),
      runtime,
    })),
  });
  try {
    await body(members);
  } finally {
    await removeWorkspaceRecord(path, process.pid);
    for (const { listener } of members) await listener.close();
  }
}

async function exchanged(messages: readonly Fields[]) {
  const server = startMcp({ argumentsList: ["--workspace"], environment });
  for (const message of messages) server.send(message);
  const output = await server.end();
  return { ...output, messages: server.messages };
}

const toolCall = (
  id: number,
  call: { readonly name: string; readonly values: Fields },
) =>
  request({
    id,
    method: "tools/call",
    params: { name: call.name, arguments: call.values },
  });

const run = { workflowId: "develop", prompt: "Work", commandId: "command-1" };

function resultOf(messages: readonly Fields[], id: number): Fields {
  return fields(messages.find((message) => message["id"] === id)?.["result"]);
}

await test("CLV-312 the workspace MCP server lists the repositories, gives each tool a repository argument, and refuses arguments that are not an object, an unknown tool and an argument that cloving_repositories does not take", () =>
  withWorkspace(["alpha", "beta"], async () => {
    const output = await exchanged([
      request({ id: 1, method: "tools/list" }),
      toolCall(2, { name: "cloving_repositories", values: {} }),
      request({
        id: 3,
        method: "tools/call",
        params: { name: "cloving_repositories" },
      }),
      request({
        id: 4,
        method: "tools/call",
        params: { name: "cloving_status", arguments: "alpha" },
      }),
      toolCall(5, { name: "cloving_nothing", values: {} }),
      toolCall(6, { name: "cloving_repositories", values: { limit: 1 } }),
    ]);
    assert.equal(output.status, 0, output.stderr);
    const tools = items(resultOf(output.messages, 1)["tools"]).map(fields);
    const status = tools.find((tool) => tool["name"] === "cloving_status");
    assert.deepEqual(
      fields(fields(status?.["inputSchema"])["properties"])["repository"],
      { type: "string", enum: ["alpha", "beta"] },
    );
    assert.equal(
      tools.some((tool) => tool["name"] === "cloving_repositories"),
      true,
    );
    const listed = fields(resultOf(output.messages, 2)["structuredContent"]);
    assert.equal(listed["kind"], "workspace-status");
    assert.deepEqual(
      items(listed["repositories"]).map((entry) => [
        fields(entry)["name"],
        fields(entry)["service"],
      ]),
      [
        ["alpha", "up"],
        ["beta", "up"],
      ],
    );
    assert.equal(
      fields(resultOf(output.messages, 3)["structuredContent"])["kind"],
      "workspace-status",
    );
    for (const id of [4, 5, 6])
      assert.equal(
        fields(
          output.messages.find((message) => message["id"] === id)?.["error"],
        )["code"],
        -32602,
      );
  }));

await test("CLV-312 a workspace tool call that changes state needs the repository argument when the workspace lists more than one repository, and a read with no repository argument reads every repository", () =>
  withWorkspace(["alpha", "beta"], async ([alpha, beta]) => {
    const output = await exchanged([
      toolCall(1, { name: "cloving_run", values: run }),
      toolCall(2, {
        name: "cloving_run",
        values: { ...run, repository: "beta" },
      }),
      toolCall(3, {
        name: "cloving_run",
        values: { ...run, repository: "gamma" },
      }),
      toolCall(4, { name: "cloving_questions", values: {} }),
    ]);
    assert.equal(output.status, 0, output.stderr);
    const refused = resultOf(output.messages, 1);
    assert.equal(refused["isError"], true);
    assert.equal(
      fields(refused["structuredContent"])["code"],
      "repository-required",
    );
    assert.match(
      String(fields(refused["structuredContent"])["detail"]),
      /alpha, beta/,
    );
    assert.equal(
      fields(resultOf(output.messages, 2)["structuredContent"])["runId"],
      "run-beta",
    );
    assert.equal(
      fields(output.messages.find((message) => message["id"] === 3)?.["error"])[
        "code"
      ],
      -32602,
    );
    const shown = fields(resultOf(output.messages, 4)["structuredContent"]);
    assert.equal(shown["kind"], "workspace-read");
    assert.deepEqual(
      items(shown["repositories"]).map((entry) => [
        fields(entry)["repository"],
        fields(fields(entry)["result"])["kind"],
      ]),
      [
        ["alpha", "questions"],
        ["beta", "questions"],
      ],
    );
    assert.deepEqual(
      [alpha, beta].map(
        (shown) =>
          shown?.requests.filter((sent) => sent.operation === "run").length,
      ),
      [0, 1],
    );
  }));

await test("CLV-312 a workspace schedule pause or resume with no repository argument needs the repository argument when the workspace lists more than one repository and reaches no repository", () =>
  withWorkspace(["alpha", "beta"], async ([alpha, beta]) => {
    const output = await exchanged([
      toolCall(1, {
        name: "cloving_schedule_pause",
        values: { workflowId: "docs-drift" },
      }),
      toolCall(2, {
        name: "cloving_schedule_resume",
        values: { workflowId: "docs-drift" },
      }),
    ]);
    assert.equal(output.status, 0, output.stderr);
    for (const id of [1, 2]) {
      const refused = resultOf(output.messages, id);
      assert.equal(refused["isError"], true);
      assert.equal(
        fields(refused["structuredContent"])["code"],
        "repository-required",
      );
    }
    assert.deepEqual(
      [alpha, beta].map(
        (shown) =>
          shown?.requests.filter((sent) => sent.operation === "schedule")
            .length,
      ),
      [0, 0],
    );
  }));

await test("CLV-312 a workspace of one repository needs no repository argument", async () => {
  await withWorkspace(["solo"], async ([solo]) => {
    const output = await exchanged([
      toolCall(1, { name: "cloving_run", values: run }),
    ]);
    assert.equal(
      fields(resultOf(output.messages, 1)["structuredContent"])["runId"],
      "run-solo",
    );
    assert.equal(
      solo?.requests.filter((sent) => sent.operation === "run").length,
      1,
    );
  });
});

await test("CLV-312 cloving mcp --workspace refuses to start with no running workspace", async () => {
  const output = await exchanged([]);
  assert.equal(output.status, 2);
  assert.match(output.stderr, /^workspace-not-running: /);
});

await test("CLV-312 cloving mcp parses --workspace and refuses it together with --repository", () => {
  assert.deepEqual(parseInvocation(["mcp", "--workspace"]), {
    kind: "mcp",
    workspace: true,
  });
  assert.deepEqual(
    parseInvocation(["mcp", "--workspace", "--repository", "alpha"]),
    { kind: "usage-error", code: "unexpected-option", json: false },
  );
  assert.match(
    String(commandUsage["mcp"]).replaceAll("\n", " "),
    /cloving mcp --workspace.*cloving_repositories.*repository argument.*more than one repository/,
  );
});
