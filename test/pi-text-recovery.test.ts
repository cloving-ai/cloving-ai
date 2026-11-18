import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  alive,
  field,
  intent,
  journalKey,
  record,
  resultOf,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";
import { fakePi } from "./pi-fixture.ts";
import { nativePiTurn } from "../src/daemon/pi-session.ts";

await test("CLV-373 changing retained native pi to a custom text turn refuses reinterpretation without another invocation", () =>
  withScene(async (scene) => {
    const path = fakePi(scene, { gate: join(scene.directory, "release") });
    const first = scene.worker("unused", { harness: { name: "pi", path } });
    const signal = new AbortController().signal;
    await first.deliver(intent(), signal);
    await until(() => existsSync(join(scene.directory, "observed.json")));
    await first.close({ turns: "keep" });
    const next = scene.worker("unused", {
      harness: { name: "pi", path, turn: [path, "{prompt}"] },
    });
    const reply = await next.reconcile(intent(), signal);
    assert.equal(reply.kind, "failed");
    assert.equal(field(reply, "reason"), "claude-turn-interrupted");
    assert.equal(
      readFileSync(join(scene.directory, "pi-prompts.jsonl"), "utf8")
        .trim()
        .split("\n").length,
      1,
    );
  }));

await test("CLV-373 a retained pi record without native session ownership is never adopted as native", () =>
  withScene(async (scene) => {
    const path = fakePi(scene, { gate: join(scene.directory, "release") });
    const settings = { harness: { name: "pi", path } };
    const first = scene.worker("unused", settings);
    const signal = new AbortController().signal;
    await first.deliver(intent(), signal);
    await until(() => existsSync(join(scene.directory, "observed.json")));
    await first.close({ turns: "keep" });
    const started = record(scene, "operation-1/started.json");
    const session = field(started, "piSession");
    const folder = join(String(field(session, "path")), "..", "..");
    const legacy = {
      ...resultOf(JSON.stringify(started)),
      piSession: undefined,
    };
    writeFileSync(join(folder, "started.json"), JSON.stringify(legacy));
    const reply = await scene
      .worker("unused", settings)
      .reconcile(intent(), signal);
    assert.equal(reply.kind, "failed");
    assert.equal(field(reply, "reason"), "pi-session-state-missing");
    assert.equal(
      readFileSync(join(scene.directory, "pi-prompts.jsonl"), "utf8")
        .trim()
        .split("\n").length,
      1,
    );
  }));

async function crashedTextTurn(scene: Scene, name: string) {
  const path = fakePi(scene, { gate: join(scene.directory, "release") });
  const settings = { harness: { name, turn: [path, "{prompt}"] } };
  const first = scene.worker("unused", settings);
  await first.deliver(intent(), new AbortController().signal);
  await until(
    () =>
      existsSync(join(scene.directory, "observed.json")) &&
      field(record(scene, "operation-1/started.json"), "phase") === "running",
  );
  const started = record(scene, "operation-1/started.json");
  await first.close();
  const folder = join(scene.journal, journalKey("operation-1"));
  rmSync(join(folder, "result.json"));
  await until(() => !alive(Number(field(started, "processId"))));
  return { folder, started, next: scene.worker("unused", settings) };
}

function prompts(scene: Scene): number {
  return readFileSync(join(scene.directory, "pi-prompts.jsonl"), "utf8")
    .trim()
    .split("\n").length;
}

for (const name of ["pi", "mytool"])
  await test(`#840 v1.9 custom text ${name} turn with a gone process after a crash ends interrupted`, () =>
    withScene(async (scene) => {
      const { started, next } = await crashedTextTurn(scene, name);
      assert.equal(field(started, "harness"), name);
      assert.equal(field(started, "launch"), undefined);
      const reply = await next.reconcile(
        intent(),
        new AbortController().signal,
      );
      assert.deepEqual(
        [reply.kind, field(reply, "reason"), field(reply, "evidence")],
        ["failed", "claude-turn-interrupted", undefined],
      );
      assert.equal(
        field(record(scene, "operation-1/result.json"), "reason"),
        "claude-turn-interrupted",
      );
      assert.equal(prompts(scene), 1);
    }));

for (const name of ["pi", "mytool"])
  await test(`#840 a drop of a crashed v1.9 custom text ${name} turn during recovery reconciles it`, () =>
    withScene(async (scene) => {
      const { next } = await crashedTextTurn(scene, name);
      const reply = await next.stop(intent(), new AbortController().signal);
      assert.deepEqual(
        [reply.kind, field(reply, "reason"), field(reply, "evidence")],
        ["failed", "claude-turn-interrupted", undefined],
      );
      assert.equal(
        field(record(scene, "operation-1/result.json"), "reason"),
        "claude-turn-interrupted",
      );
      assert.equal(record(scene, "operation-1/stop-request.json"), undefined);
      assert.equal(prompts(scene), 1);
    }));

const v19Fields = [
  "harness",
  "operationId",
  "target",
  "branch",
  "worktree",
  "startCommit",
  "turnStartCommit",
  "model",
  "attempt",
  "startedAt",
  "phase",
  "processId",
];

for (const attempt of ["kept", "missing"])
  for (const selection of ["text", "native"])
    for (const action of ["reconcile", "stop"] as const)
      await test(`#840 a v1.9 pi record with a ${attempt} attempt record and ${selection} settings ends interrupted after ${action}`, () =>
        withScene(async (scene) => {
          const { folder, started } = await crashedTextTurn(scene, "pi");
          const v19 = Object.fromEntries(
            v19Fields.map((name) => [name, field(started, name)]),
          );
          assert.deepEqual(resultOf(JSON.stringify(started)), v19);
          if (attempt === "missing") rmSync(join(folder, "attempt-1.json"));
          const path = join(scene.directory, "pi");
          const worker = scene.worker("unused", {
            harness:
              selection === "text"
                ? { name: "pi", turn: [path, "{prompt}"] }
                : { name: "pi", path },
          });
          const reply = await worker[action](
            intent(),
            new AbortController().signal,
          );
          assert.deepEqual(
            [reply.kind, field(reply, "reason"), field(reply, "evidence")],
            ["failed", "claude-turn-interrupted", undefined],
          );
          assert.equal(prompts(scene), 1);
          assert.equal(existsSync(join(folder, "pi-session")), false);
        }));

await test("#840 only a recorded private session makes a pi record native", () => {
  const piSession = { path: "session.jsonl", id: "id", cwd: "tree" };
  assert.equal(nativePiTurn({ harness: "pi", piSession }), true);
  assert.equal(nativePiTurn({ harness: "pi", phase: "running" }), false);
  assert.equal(nativePiTurn({ harness: "claude", piSession }), false);
  assert.equal(nativePiTurn(undefined), false);
});
