import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseReplyLine } from "../src/protocol.ts";
import { callTool, holdingRelay, request, startMcp } from "./mcp-fixture.ts";
import {
  call,
  fields,
  items,
  parsed,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

const submission = {
  workflowId: "develop",
  prompt: "build the parser",
  commandId: "c-1",
};
const cliRun = [
  "run",
  "develop",
  "--prompt",
  "build the parser",
  "--command-id",
  "c-1",
  "--json",
];

async function runIds(harness: Harness): Promise<readonly unknown[]> {
  const page = await call(harness, { operation: "status", parameters: {} });
  return items(page["runs"]).map((run) => fields(run)["runId"]);
}

function toolRun(harness: Harness) {
  return callTool({
    runtime: harness.runtimeDirectory,
    name: "cloving_run",
    arguments: submission,
  });
}

await test("CLV-251 a cloving_run call and then a CLI run with the same command ID give one run and one receipt", () =>
  withHarness(async (harness) => {
    await harness.start();
    const tool = await toolRun(harness);
    assert.notEqual(tool["isError"], true);
    const first = fields(tool["structuredContent"]);
    const cli = await harness.cli(cliRun);
    assert.equal(cli.status, 0, cli.stderr);
    const second = parsed(cli);
    assert.deepEqual([first["replayed"], second["replayed"]], [false, true]);
    assert.equal(second["runId"], first["runId"]);
    assert.deepEqual(second["receipt"], first["receipt"]);
    assert.equal(harness.resolved.length, 1);
    assert.deepEqual(await runIds(harness), [first["runId"]]);
  }));

await test("CLV-251 a CLI run and then a cloving_run call with the same command ID give one run and one receipt", () =>
  withHarness(async (harness) => {
    await harness.start();
    const cli = await harness.cli(cliRun);
    assert.equal(cli.status, 0, cli.stderr);
    const first = parsed(cli);
    const tool = await toolRun(harness);
    assert.notEqual(tool["isError"], true);
    const second = fields(tool["structuredContent"]);
    assert.deepEqual([first["replayed"], second["replayed"]], [false, true]);
    assert.equal(second["runId"], first["runId"]);
    assert.deepEqual(second["receipt"], first["receipt"]);
    assert.equal(harness.resolved.length, 1);
    assert.deepEqual(await runIds(harness), [first["runId"]]);
  }));

async function relayed(harness: Harness) {
  const runtime = join(dirname(harness.runtimeDirectory), "relay");
  const relay = await holdingRelay({
    service: harness.runtimeDirectory,
    runtime,
  });
  const mcp = startMcp({ runtime });
  harness.cleanup(() => {
    mcp.child.kill();
    relay.close();
  });
  mcp.send(
    request({
      id: "run",
      method: "tools/call",
      params: { name: "cloving_run", arguments: submission },
    }),
  );
  return { mcp, held: await relay.held };
}

await test("CLV-251 a lost cloving_run reply gives outcome-unknown, and the repeated call gives the stored receipt of the one run", () =>
  withHarness(async (harness) => {
    await harness.start();
    const { mcp, held } = await relayed(harness);
    const admitted = parseReplyLine(held.line);
    assert.equal(admitted?.kind, "result");
    held.client.destroy();
    const output = await mcp.end();
    assert.equal(output.status, 0, output.stderr);
    const lost = fields(mcp.messages[0]?.["result"]);
    assert.equal(lost["isError"], true);
    assert.deepEqual(
      { ...fields(lost["structuredContent"]), detail: "" },
      {
        schemaVersion: 1,
        kind: "error",
        code: "outcome-unknown",
        detail: "",
        commandId: "c-1",
        runId: null,
        currentRevision: null,
      },
    );
    const repeated = fields((await toolRun(harness))["structuredContent"]);
    const first = fields(admitted.result);
    assert.equal(repeated["replayed"], true);
    assert.equal(repeated["runId"], first["runId"]);
    assert.deepEqual(repeated["receipt"], first["receipt"]);
    assert.equal(harness.resolved.length, 1);
    assert.deepEqual(await runIds(harness), [first["runId"]]);
  }));

await test("CLV-251 a cancel of an admitted cloving_run sends no reply, and cloving_status shows the run", () =>
  withHarness(async (harness) => {
    await harness.start();
    const { mcp, held } = await relayed(harness);
    const admitted = parseReplyLine(held.line);
    assert.equal(admitted?.kind, "result");
    const closed = once(held.client, "close");
    mcp.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "run", reason: "test" },
    });
    await closed;
    mcp.send(request({ id: "ping", method: "ping" }));
    const output = await mcp.end();
    assert.equal(output.status, 0, output.stderr);
    assert.deepEqual(mcp.messages, [
      { jsonrpc: "2.0", id: "ping", result: {} },
    ]);
    const status = await callTool({
      runtime: harness.runtimeDirectory,
      name: "cloving_status",
    });
    assert.deepEqual(
      items(fields(status["structuredContent"])["runs"]).map(
        (run) => fields(run)["runId"],
      ),
      [fields(admitted.result)["runId"]],
    );
  }));

await test("CLV-251 the same command ID with a different prompt gives conflicting-command as the CLI does", () =>
  withHarness(async (harness) => {
    await harness.start();
    await toolRun(harness);
    const changed = { ...submission, prompt: "build the printer" };
    const tool = await callTool({
      runtime: harness.runtimeDirectory,
      name: "cloving_run",
      arguments: changed,
    });
    const cli = await harness.cli(
      cliRun.map((word) =>
        word === submission.prompt ? changed.prompt : word,
      ),
    );
    assert.equal(cli.status, 1);
    assert.equal(tool["isError"], true);
    assert.equal(
      fields(tool["structuredContent"])["code"],
      "conflicting-command",
    );
    assert.deepEqual(tool["structuredContent"], parsed(cli));
    assert.equal(harness.resolved.length, 1);
  }));

await test("CLV-251 cloving_run with a ticket ID, next or an input object sends the request of the CLI and gives its JSON", () =>
  withHarness(async (harness) => {
    await harness.start({
      workflows: [
        {
          ...harness.registration,
          submission: { maximumBytes: 4096, fields: { ticket: "string" } },
        },
      ],
    });
    await writeFile(
      join(harness.projectDirectory, "input.json"),
      JSON.stringify({ ticket: "43" }),
    );
    for (const [commandId, source, options] of [
      ["c-ticket", { ticket: "42" }, ["--ticket", "42"]],
      ["c-next", { ticket: "next" }, ["--next"]],
      ["c-input", { input: { ticket: "43" } }, ["--input", "input.json"]],
    ] as const) {
      const cli = [
        "run",
        "develop",
        ...options,
        "--command-id",
        commandId,
        "--json",
      ];
      const admitted = await harness.cli(cli);
      assert.equal(admitted.status, 0, admitted.stderr);
      const tool = await callTool({
        runtime: harness.runtimeDirectory,
        name: "cloving_run",
        arguments: { workflowId: "develop", ...source, commandId },
      });
      const replayed = await harness.cli(cli);
      assert.equal(fields(tool["structuredContent"])["replayed"], true);
      assert.deepEqual(tool["structuredContent"], parsed(replayed));
    }
    assert.deepEqual(
      harness.resolved.map((resolved) => fields(resolved)["submission"]),
      [{ ticket: "42" }, { ticket: "next" }, { ticket: "43" }],
    );
  }));
