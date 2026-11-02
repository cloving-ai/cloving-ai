import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { callTool } from "./mcp-fixture.ts";
import {
  call,
  fields,
  items,
  parsed,
  runCli,
  waitingGate,
  withHarness,
} from "./service-fixture.ts";

await test("CLV-250 mcp status and questions have the same JSON as the CLI", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const { runId } = await waitingGate(harness, {
      service,
      commandId: "question",
      kind: "question",
    });
    for (const [name, argumentsObject, command] of [
      ["cloving_status", undefined, ["status", "--json"]],
      ["cloving_status", { runId }, ["status", runId, "--json"]],
      [
        "cloving_status",
        { limit: 1, after: "run-0" },
        ["status", "--limit", "1", "--after", "run-0", "--json"],
      ],
      ["cloving_questions", undefined, ["questions", "--json"]],
      ["cloving_questions", { runId }, ["questions", runId, "--json"]],
    ] as const) {
      const cli = await runCli(command, {
        directory: harness.projectDirectory,
        runtime: harness.runtimeDirectory,
      });
      assert.equal(cli.status, 0, cli.stderr);
      const result = await callTool({
        runtime: harness.runtimeDirectory,
        name: name,
        arguments: argumentsObject,
      });
      assert.deepEqual(result["structuredContent"], parsed(cli));
      assert.deepEqual(result["content"], [
        { type: "text", text: JSON.stringify(parsed(cli)) },
      ]);
      assert.notEqual(result["isError"], true);
    }
  }));

await test("CLV-250 mcp status includes the same CI rerun notice as the CLI", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const { runId } = await waitingGate(harness, {
      service,
      commandId: "ci",
      kind: "approval",
    });
    const folder = join(dirname(harness.runtimeDirectory), "github", "merge");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "started.json"),
      JSON.stringify({ method: "merge", runId }),
    );
    const commit = "a".repeat(40);
    await writeFile(
      join(folder, `ci-${"a".repeat(32)}.json`),
      JSON.stringify({ commit, reruns: [{ run: "42", requestedAt: 1234 }] }),
    );
    const cli = await harness.cli(["status", runId, "--json"]);
    const result = await callTool({
      runtime: harness.runtimeDirectory,
      name: "cloving_status",
      arguments: {
        runId,
      },
    });
    assert.deepEqual(fields(parsed(cli)["run"])["ciReruns"], [
      { commit, run: "42", requestedAt: 1234 },
    ]);
    assert.deepEqual(result["structuredContent"], parsed(cli));
  }));

await test("CLV-250 mcp events return the service page and preserve the CLI event JSON", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const { runId } = await waitingGate(harness, {
      service,
      commandId: "events",
      kind: "question",
    });
    const page = await call(harness, {
      operation: "events",
      parameters: { runId, after: 0, limit: 1000 },
    });
    const sequences = items(page["events"]).map((event) =>
      Number(fields(event)["sequence"]),
    );
    assert.ok(sequences.length > 2);
    const after = sequences[1] ?? 0;
    const cli = await harness.cli([
      "events",
      runId,
      "--after",
      String(after),
      "--limit",
      "2",
      "--json",
    ]);
    assert.equal(cli.status, 0, cli.stderr);
    const result = await callTool({
      runtime: harness.runtimeDirectory,
      name: "cloving_events",
      arguments: {
        runId,
        after,
        limit: 2,
      },
    });
    const content = fields(result["structuredContent"]);
    assert.deepEqual(
      content,
      await call(harness, {
        operation: "events",
        parameters: { runId, after, limit: 2 },
      }),
    );
    const events: unknown[] = cli.stdout
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    assert.deepEqual(content["events"], events);
    assert.ok(
      events.every((event) => Number(fields(event)["sequence"]) > after),
    );
    assert.deepEqual(result["content"], [
      { type: "text", text: JSON.stringify(content) },
    ]);
  }));

await test("CLV-250 mcp service errors have the same JSON as the CLI", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const missing = await harness.cli(["status", "absent", "--json"]);
    const unknown = await callTool({
      runtime: harness.runtimeDirectory,
      name: "cloving_status",
      arguments: {
        runId: "absent",
      },
    });
    assert.equal(unknown["isError"], true);
    assert.deepEqual(unknown["structuredContent"], parsed(missing));
    await service.close();
    const cli = await harness.cli(["status", "--json"]);
    const result = await callTool({
      runtime: harness.runtimeDirectory,
      name: "cloving_status",
    });
    assert.equal(cli.status, 1);
    assert.equal(result["isError"], true);
    assert.deepEqual(result["structuredContent"], parsed(cli));
    assert.equal(
      fields(result["structuredContent"])["code"],
      "service-unavailable",
    );
    assert.deepEqual(result["content"], [
      { type: "text", text: JSON.stringify(parsed(cli)) },
    ]);
  }));

await test("CLV-250 mcp events accept no arguments", () =>
  withHarness(async (harness) => {
    await harness.start();
    const all = await callTool({
      runtime: harness.runtimeDirectory,
      name: "cloving_events",
    });
    assert.deepEqual(
      all["structuredContent"],
      await call(harness, { operation: "events", parameters: {} }),
    );
  }));
