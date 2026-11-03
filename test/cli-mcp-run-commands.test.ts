import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fields } from "../src/protocol.ts";
import { callTool, sameAsCli } from "./mcp-fixture.ts";
import {
  fields,
  waitingGate,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

async function shown(harness: Harness, runId: string): Promise<Fields> {
  const status = await callTool({
    runtime: harness.runtimeDirectory,
    name: "cloving_status",
    arguments: { runId },
  });
  return fields(fields(status["structuredContent"])["run"]);
}

function options(values: Fields): readonly string[] {
  return [
    String(values["runId"]),
    "--expected-revision",
    String(values["expectedRevision"]),
    "--command-id",
    String(values["commandId"]),
  ];
}

await test("CLV-251 cloving_pause, cloving_resume and cloving_drop commit the run command and give the JSON of the CLI, and a stale expectedRevision changes nothing", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const { runId } = await waitingGate(harness, {
      service,
      commandId: "gate",
      kind: "question",
    });
    const before = await shown(harness, runId);
    const stale = {
      runId,
      expectedRevision: Number(before["revision"]) - 1,
      commandId: "c-stale",
    };
    const refused = await sameAsCli(harness, {
      name: "cloving_drop",
      arguments: stale,
      cli: ["drop", ...options(stale)],
    });
    assert.equal(refused.first["isError"], true);
    assert.equal(
      fields(refused.first["structuredContent"])["code"],
      "stale-revision",
    );
    assert.deepEqual(await shown(harness, runId), before);
    for (const [command, state] of [
      ["pause", "paused"],
      ["resume", "waiting_gate"],
      ["drop", "cancelled"],
    ] as const) {
      const values = {
        runId,
        expectedRevision: (await shown(harness, runId))["revision"],
        commandId: `c-${command}`,
      };
      const { first, cli } = await sameAsCli(harness, {
        name: `cloving_${command}`,
        arguments: values,
        cli: [command, ...options(values)],
      });
      assert.notEqual(first["isError"], true, JSON.stringify(first));
      const content = fields(first["structuredContent"]);
      assert.deepEqual([content["replayed"], cli["replayed"]], [false, true]);
      assert.deepEqual(content["receipt"], cli["receipt"]);
      assert.equal(fields(content["committed"])["state"], state);
    }
  }));
