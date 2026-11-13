import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  alive,
  field,
  intent,
  record,
  resultOf,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";
import { operationFile } from "./harness-detached-fixture.ts";
import { fakePi } from "./pi-fixture.ts";
import { activeOwners } from "../src/daemon/turn-owners.ts";

async function keptPi(scene: Scene) {
  const gate = join(scene.directory, "release");
  const settings = { harness: { name: "pi", path: fakePi(scene, { gate }) } };
  const worker = scene.worker("unused", settings);
  const signal = new AbortController().signal;
  await worker.deliver(intent(), signal);
  await until(() => existsSync(join(scene.directory, "observed.json")));
  const started = resultOf(
    JSON.stringify(record(scene, "operation-1/started.json")),
  );
  const entry = resultOf(
    JSON.stringify(record(scene, "operation-1/attempt-1.json")),
  );
  await worker.close({ turns: "keep" });
  const next = scene.worker("unused", settings);
  return { gate, signal, started, entry, next };
}

function save(
  scene: Scene,
  entry: { readonly name: string; readonly value: unknown },
): void {
  writeFileSync(
    operationFile(scene, { operationId: "operation-1", name: entry.name }),
    JSON.stringify(entry.value),
  );
}

function prompts(scene: Scene): number {
  return readFileSync(join(scene.directory, "pi-prompts.jsonl"), "utf8")
    .trim()
    .split("\n").length;
}

await test("CLV-365 Pi refuses a stale attempt before restart adoption or another prompt", () =>
  withScene(async (scene) => {
    const { gate, signal, started, entry, next } = await keptPi(scene);
    save(scene, { name: "started.json", value: { ...started, attempt: 2 } });
    save(scene, { name: "attempt-2.json", value: entry });
    const before = record(scene, "operation-1/started.json");
    const reply = await next.reconcile(intent(), signal);
    assert.equal(reply.kind, "unknown");
    assert.match(
      String(field(reply, "evidence")),
      /pi-attempt-ownership-conflict/,
    );
    assert.equal(alive(Number(field(started["launch"], "processId"))), true);
    assert.deepEqual(record(scene, "operation-1/started.json"), before);
    assert.equal(prompts(scene), 1);
    assert.equal(scene.reports.length, 0);
    writeFileSync(gate, "release");
    await until(() => !alive(Number(field(started["launch"], "processId"))));
  }));

await test("CLV-365 Pi refuses conflicting launch ownership before attachment or signaling", async () => {
  for (const change of [
    { processId: 1 },
    { processStart: "foreign-start" },
    { marker: "foreign-marker" },
    { output: "foreign-output" },
    { offset: 1 },
    { transcript: { path: "foreign-transcript", offset: 0 } },
  ])
    await withScene(async (scene) => {
      const { gate, signal, started, entry, next } = await keptPi(scene);
      const launch = {
        ...resultOf(JSON.stringify(entry["launch"])),
        ...change,
      };
      save(scene, { name: "attempt-1.json", value: { ...entry, launch } });
      const reply = await next.reconcile(intent(), signal);
      assert.equal(reply.kind, "unknown");
      assert.match(
        String(field(reply, "evidence")),
        /pi-attempt-ownership-conflict/,
      );
      assert.equal(alive(Number(field(started["launch"], "processId"))), true);
      assert.equal(prompts(scene), 1);
      assert.equal(record(scene, "operation-1/result.json"), undefined);
      writeFileSync(gate, "release");
      await until(() => !alive(Number(field(started["launch"], "processId"))));
    });
});

await test("CLV-365 Pi refuses conflicting attempt metadata without terminating the retained process", async () => {
  for (const change of [
    { harness: "claude" },
    { operationId: "foreign-operation" },
    { target: "ticket/foreign" },
    { worktree: "foreign-tree" },
    { processId: 1 },
  ])
    await withScene(async (scene) => {
      const { gate, signal, started, entry, next } = await keptPi(scene);
      save(scene, { name: "attempt-1.json", value: { ...entry, ...change } });
      const reply = await next.reconcile(intent(), signal);
      assert.equal(reply.kind, "unknown");
      assert.match(
        String(field(reply, "evidence")),
        /pi-attempt-ownership-conflict/,
      );
      assert.equal(alive(Number(field(started["launch"], "processId"))), true);
      assert.equal(prompts(scene), 1);
      writeFileSync(gate, "release");
      await until(() => !alive(Number(field(started["launch"], "processId"))));
    });
});

await test("CLV-365 Pi refuses missing attempt evidence without settling or signaling the retained process", () =>
  withScene(async (scene) => {
    const { gate, signal, started, next } = await keptPi(scene);
    rmSync(
      operationFile(scene, {
        operationId: "operation-1",
        name: "attempt-1.json",
      }),
    );
    const reply = await next.reconcile(intent(), signal);
    assert.equal(reply.kind, "unknown");
    assert.match(String(field(reply, "evidence")), /pi-attempt-state-missing/);
    assert.equal(alive(Number(field(started["launch"], "processId"))), true);
    assert.equal(prompts(scene), 1);
    assert.equal(record(scene, "operation-1/result.json"), undefined);
    writeFileSync(gate, "release");
    await until(() => !alive(Number(field(started["launch"], "processId"))));
  }));

await test("CLV-365 Pi reconciles an exited lost start once before considering another invocation", () =>
  withScene(async (scene) => {
    const { gate, signal, started, next } = await keptPi(scene);
    const interrupted: Record<string, unknown> = {
      ...started,
      phase: "starting",
      processId: null,
    };
    delete interrupted["launch"];
    save(scene, { name: "started.json", value: interrupted });
    writeFileSync(gate, "release");
    await until(() => !alive(Number(field(started["launch"], "processId"))));
    const replies = await Promise.all([
      next.reconcile(intent(), signal),
      next.reconcile(intent(), signal),
    ]);
    assert.deepEqual(
      replies.map((reply) => reply.kind),
      ["accepted", "accepted"],
    );
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const result = resultOf(scene.reports[0].result);
    assert.equal(result["turns"], 1);
    assert.equal(
      resultOf(JSON.stringify(result["usage"]))["input_tokens"],
      100,
    );
    assert.equal(prompts(scene), 1);
    assert.equal((await next.reconcile(intent(), signal)).kind, "completed");
    assert.equal(scene.reports.length, 1);
    assert.equal(prompts(scene), 1);
  }));

await test("CLV-365 Pi reports an uncertain prior result when its process dies without an exit record", () =>
  withScene(async (scene) => {
    const { signal, started, entry, next } = await keptPi(scene);
    const processId = Number(field(started["launch"], "processId"));
    process.kill(-processId, "SIGKILL");
    await until(
      () => !alive(processId) && !alive(scene.turns()[0]?.processId ?? 0),
    );
    const reply = await next.reconcile(intent(), signal);
    assert.equal(reply.kind, "unknown");
    assert.match(String(field(reply, "evidence")), /pi-prior-result-uncertain/);
    assert.deepEqual(record(scene, "operation-1/started.json"), started);
    assert.deepEqual(record(scene, "operation-1/attempt-1.json"), entry);
    assert.equal(record(scene, "operation-1/result.json"), undefined);
    assert.equal(scene.reports.length, 0);
    assert.equal(prompts(scene), 1);
  }));

await test("CLV-365 Pi refuses malformed attempt state with a recovery reason and no signal", async () => {
  for (const text of ["{", "[]", "null", "12"])
    await withScene(async (scene) => {
      const { gate, signal, started, next } = await keptPi(scene);
      writeFileSync(
        operationFile(scene, {
          operationId: "operation-1",
          name: "attempt-1.json",
        }),
        text,
      );
      const reply = await next.reconcile(intent(), signal);
      assert.equal(reply.kind, "unknown");
      assert.match(
        String(field(reply, "evidence")),
        /pi-attempt-state-invalid/,
      );
      assert.equal(alive(Number(field(started["launch"], "processId"))), true);
      assert.equal(prompts(scene), 1);
      writeFileSync(gate, "release");
      await until(() => !alive(Number(field(started["launch"], "processId"))));
    });
});

await test("CLV-365 Pi rebuilds a lost final result from its settled attempt without a new prompt or usage", () =>
  withScene(async (scene) => {
    const settings = { harness: { name: "pi", path: fakePi(scene) } };
    const signal = new AbortController().signal;
    const first = scene.worker("unused", settings);
    await first.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    const original = scene.reports[0];
    assert.equal(original?.outcome, "completed");
    assert.equal(
      typeof field(record(scene, "operation-1/attempt-1.json"), "endedAt"),
      "string",
    );
    rmSync(
      operationFile(scene, { operationId: "operation-1", name: "result.json" }),
    );
    await first.close({ turns: "keep" });
    const next = scene.worker("unused", settings);
    const replies = await Promise.all([
      next.reconcile(intent(), signal),
      next.reconcile(intent(), signal),
    ]);
    assert.deepEqual(
      replies.map((reply) => reply.kind),
      ["accepted", "accepted"],
    );
    await until(() => scene.reports.length === 2);
    assert.equal(scene.reports[1]?.outcome, "completed");
    const expected = resultOf(original.result);
    const recovered = resultOf(scene.reports[1].result);
    for (const name of [
      "summary",
      "usage",
      "costUsd",
      "turns",
      "sessionId",
      "attempts",
    ])
      assert.deepEqual(recovered[name], expected[name]);
    assert.equal(prompts(scene), 1);
    assert.equal((await next.reconcile(intent(), signal)).kind, "completed");
    assert.equal(scene.reports.length, 2);
  }));

await test("CLV-365 daemon hold tolerates corrupt Pi evidence before recovery reports uncertainty", () =>
  withScene(async (scene) => {
    const { gate, started, next } = await keptPi(scene);
    writeFileSync(
      operationFile(scene, {
        operationId: "operation-1",
        name: "attempt-1.json",
      }),
      "{",
    );
    assert.equal(await next.hold(intent()), true);
    assert.deepEqual(await activeOwners(String(started["worktree"])), [
      {
        runId: "run-1",
        processId: Number(field(started["launch"], "processId")),
      },
    ]);
    await assert.doesNotReject(() => next.recover(intent()));
    assert.equal(alive(Number(field(started["launch"], "processId"))), true);
    assert.equal(record(scene, "operation-1/result.json"), undefined);
    assert.equal(scene.reports.length, 0);
    assert.equal(prompts(scene), 1);
    writeFileSync(gate, "release");
    await until(() => !alive(Number(field(started["launch"], "processId"))));
  }));

await test("CLV-365 Pi lost-start process death preserves uncertainty before worktree cleanup", async () => {
  for (const phase of ["starting", "running"])
    await withScene(async (scene) => {
      const { signal, started, next } = await keptPi(scene);
      const processId = Number(field(started["launch"], "processId"));
      const interrupted: Record<string, unknown> = { ...started, phase };
      delete interrupted["launch"];
      if (phase === "starting") interrupted["processId"] = null;
      save(scene, { name: "started.json", value: interrupted });
      process.kill(-processId, "SIGKILL");
      await until(
        () => !alive(processId) && !alive(scene.turns()[0]?.processId ?? 0),
      );
      const reply = await next.reconcile(intent(), signal);
      assert.equal(reply.kind, "unknown");
      assert.match(
        String(field(reply, "evidence")),
        /pi-prior-result-uncertain/,
      );
      assert.deepEqual(record(scene, "operation-1/started.json"), interrupted);
      assert.equal(record(scene, "operation-1/result.json"), undefined);
      assert.equal(scene.reports.length, 0);
      assert.equal(prompts(scene), 1);
    });
});
