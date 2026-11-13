import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
import { fakePi, piEvents } from "./pi-fixture.ts";
import { operationFile } from "./harness-detached-fixture.ts";

async function runningPi(scene: Scene) {
  const gate = join(scene.directory, "release");
  const settings = {
    tokenPrices: {
      "test-provider/test-model": { input: 2, cachedInput: 0.5, output: 8 },
    },
    harness: {
      name: "pi",
      path: fakePi(scene, { gate, afterGateEvents: piEvents().slice(2, 4) }),
    },
  };
  const first = scene.worker("unused", settings);
  const signal = new AbortController().signal;
  await first.deliver(intent(), signal);
  await until(() => existsSync(join(scene.directory, "observed.json")));
  const started = record(scene, "operation-1/started.json");
  const session = field(started, "piSession");
  assert.ok(session, "Persist the Pi session before the CLI starts");
  return {
    gate,
    settings,
    first,
    signal,
    started,
    session,
    path: String(field(session, "path")),
  };
}

function promptCount(scene: Scene): number {
  return readFileSync(join(scene.directory, "pi-prompts.jsonl"), "utf8")
    .trim()
    .split("\n").length;
}

await test("CLV-365 private Pi selection survives restart with one prompt and the same process identity", () =>
  withScene(async (scene) => {
    const { gate, settings, first, signal, started, session, path } =
      await runningPi(scene);
    const header = resultOf(readFileSync(path, "utf8").trim());
    assert.equal(header["id"], field(session, "id"));
    assert.equal(header["cwd"], field(started, "worktree"));
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(path.startsWith(scene.journal + "/"), true);
    assert.deepEqual(
      field(record(scene, "operation-1/attempt-1.json"), "piSession"),
      session,
    );
    const launch = field(started, "launch");
    await first.close({ turns: "keep" });
    assert.equal(alive(Number(field(launch, "processId"))), true);
    const next = scene.worker("unused", settings);
    const replies = await Promise.all([
      next.reconcile(intent(), signal),
      next.reconcile(intent(), signal),
    ]);
    assert.deepEqual(
      replies.map((reply) => reply.kind),
      ["accepted", "accepted"],
    );
    writeFileSync(gate, "release");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const result = resultOf(scene.reports[0].result);
    assert.equal(result["turns"], 1);
    assert.equal(
      resultOf(JSON.stringify(result["usage"]))["input_tokens"],
      100,
    );
    assert.equal(result["estimatedCostUsd"], 0.00038);
    assert.deepEqual(
      field(record(scene, "operation-1/started.json"), "launch"),
      launch,
    );
    assert.equal(promptCount(scene), 1);
  }));

await test("CLV-365 recovery refuses a private session with foreign ownership before another prompt", () =>
  withScene(async (scene) => {
    const { first, settings, signal, path } = await runningPi(scene);
    await first.close({ turns: "keep" });
    const original = resultOf(readFileSync(path, "utf8").trim());
    writeFileSync(
      path,
      JSON.stringify({ ...original, id: "foreign-session" }) + "\n",
    );
    const next = scene.worker("unused", settings);
    const reply = await next.reconcile(intent(), signal);
    assert.equal(reply.kind, "failed");
    assert.equal(field(reply, "reason"), "pi-session-ownership-conflict");
    assert.equal(promptCount(scene), 1);
  }));

await test("CLV-365 recovery reports missing Pi state without another prompt", () =>
  withScene(async (scene) => {
    const { first, settings, signal, path } = await runningPi(scene);
    await first.close({ turns: "keep" });
    rmSync(path);
    const reply = await scene
      .worker("unused", settings)
      .reconcile(intent(), signal);
    assert.equal(reply.kind, "failed");
    assert.equal(field(reply, "reason"), "pi-session-state-missing");
    assert.equal(promptCount(scene), 1);
  }));

await test("CLV-365 recovery reports malformed Pi state without another prompt", () =>
  withScene(async (scene) => {
    const { first, settings, signal, path } = await runningPi(scene);
    await first.close({ turns: "keep" });
    writeFileSync(path, "{broken}\n");
    const reply = await scene
      .worker("unused", settings)
      .reconcile(intent(), signal);
    assert.equal(reply.kind, "failed");
    assert.equal(field(reply, "reason"), "pi-session-state-invalid");
    assert.equal(promptCount(scene), 1);
  }));

await test("CLV-365 recovery refuses a Pi session link even when its header matches", () =>
  withScene(async (scene) => {
    const { first, settings, signal, path } = await runningPi(scene);
    await first.close({ turns: "keep" });
    const foreign = join(scene.directory, "foreign-session.jsonl");
    writeFileSync(foreign, readFileSync(path));
    rmSync(path);
    symlinkSync(foreign, path);
    const reply = await scene
      .worker("unused", settings)
      .reconcile(intent(), signal);
    assert.equal(reply.kind, "failed");
    assert.equal(field(reply, "reason"), "pi-session-ownership-conflict");
    assert.equal(promptCount(scene), 1);
  }));

await test("CLV-365 foreign Pi output cannot add text or usage to the owned invocation", () =>
  withScene(async (scene) => {
    const events = [
      { version: 3, type: "session", id: "foreign-session" },
      ...piEvents().slice(1),
    ];
    const command = fakePi(scene, { events });
    await scene
      .worker("unused", { harness: { name: "pi", path: command } })
      .deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    const report = scene.reports[0];
    assert.equal(report?.outcome, "failed");
    const result = resultOf(report.result);
    assert.match(String(result["summary"]), /conflicting session/);
    assert.equal(result["turns"], 0);
    assert.equal(result["costUsd"], null);
    assert.equal(result["estimatedCostUsd"], null);
  }));

await test("CLV-365 recovery refuses a redirected Pi session path with an identical header", () =>
  withScene(async (scene) => {
    const { first, settings, signal, started, session, path } =
      await runningPi(scene);
    await first.close({ turns: "keep" });
    const foreign = join(scene.directory, "foreign-session.jsonl");
    writeFileSync(foreign, readFileSync(path));
    writeFileSync(
      operationFile(scene, {
        operationId: "operation-1",
        name: "started.json",
      }),
      JSON.stringify({
        ...resultOf(JSON.stringify(started)),
        piSession: { ...resultOf(JSON.stringify(session)), path: foreign },
      }),
    );
    const reply = await scene
      .worker("unused", settings)
      .reconcile(intent(), signal);
    assert.equal(reply.kind, "failed");
    assert.equal(field(reply, "reason"), "pi-session-ownership-conflict");
    assert.equal(promptCount(scene), 1);
  }));

await test("CLV-365 recovery refuses a Pi record from another operation", () =>
  withScene(async (scene) => {
    const { first, settings, signal, started, gate } = await runningPi(scene);
    await first.close({ turns: "keep" });
    writeFileSync(
      operationFile(scene, {
        operationId: "operation-1",
        name: "started.json",
      }),
      JSON.stringify({
        ...resultOf(JSON.stringify(started)),
        operationId: "foreign-operation",
      }),
    );
    const reply = await scene
      .worker("unused", settings)
      .reconcile(intent(), signal);
    assert.equal(reply.kind, "unknown");
    assert.match(
      String(field(reply, "evidence")),
      /pi-session-ownership-conflict/,
    );
    assert.equal(
      alive(Number(field(field(started, "launch"), "processId"))),
      true,
    );
    assert.equal(promptCount(scene), 1);
    writeFileSync(gate, "release");
    await until(
      () => !alive(Number(field(field(started, "launch"), "processId"))),
    );
  }));

await test("CLV-365 recovery refuses a different Pi target without adoption or a signal", () =>
  withScene(async (scene) => {
    const { first, settings, signal, started, gate } = await runningPi(scene);
    await first.close({ turns: "keep" });
    const reply = await scene
      .worker("unused", settings)
      .reconcile(intent({ target: "ticket/foreign" }), signal);
    assert.equal(reply.kind, "unknown");
    assert.match(
      String(field(reply, "evidence")),
      /pi-session-ownership-conflict/,
    );
    assert.equal(
      alive(Number(field(field(started, "launch"), "processId"))),
      true,
    );
    assert.equal(promptCount(scene), 1);
    writeFileSync(gate, "release");
    await until(
      () => !alive(Number(field(field(started, "launch"), "processId"))),
    );
  }));

await test("CLV-365 a conflicting Pi target cannot reconcile a lost start or change its ownership records", () =>
  withScene(async (scene) => {
    const { first, settings, signal, started, gate } = await runningPi(scene);
    await first.close({ turns: "keep" });
    const interrupted: Record<string, unknown> = {
      ...resultOf(JSON.stringify(started)),
      phase: "starting",
      processId: null,
    };
    delete interrupted["launch"];
    writeFileSync(
      operationFile(scene, {
        operationId: "operation-1",
        name: "started.json",
      }),
      JSON.stringify(interrupted),
    );
    const reply = await scene
      .worker("unused", settings)
      .reconcile(intent({ target: "ticket/foreign" }), signal);
    assert.equal(reply.kind, "unknown");
    assert.deepEqual(record(scene, "operation-1/started.json"), interrupted);
    assert.equal(
      alive(Number(field(field(started, "launch"), "processId"))),
      true,
    );
    writeFileSync(gate, "release");
    await until(
      () => !alive(Number(field(field(started, "launch"), "processId"))),
    );
  }));

await test("CLV-365 recovery refuses a redirected Pi session directory with an identical header", () =>
  withScene(async (scene) => {
    const { first, settings, signal, path } = await runningPi(scene);
    await first.close({ turns: "keep" });
    const foreign = join(scene.directory, "foreign-sessions");
    renameSync(dirname(path), foreign);
    symlinkSync(foreign, dirname(path));
    const reply = await scene
      .worker("unused", settings)
      .reconcile(intent(), signal);
    assert.equal(reply.kind, "failed");
    assert.equal(field(reply, "reason"), "pi-session-ownership-conflict");
    assert.equal(promptCount(scene), 1);
  }));
