import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TurnLaunch } from "../src/turn-launch.ts";
import type { Attempts } from "../src/daemon/turn-attempts.ts";
import { steerPi } from "../src/daemon/pi-turn-steering.ts";
import { steeringOf } from "../src/daemon/turn-steering.ts";
import { rpcFixture } from "./pi-rpc-fixture.ts";
import {
  field,
  intent,
  record,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

function attemptsAt(folder: string): Attempts {
  return {
    start: {
      worker: "pi",
      command: [],
      prompt: "task",
      directory: folder,
      folder,
    },
    startedAt: "2026-11-14T00:00:00.000Z",
    turnStartCommit: null,
    options: { runId: "run-1", metadata: {} },
    stopping: new AbortController(),
    grace: { milliseconds: 0 },
    ends: [],
    steering: steeringOf(undefined),
  };
}

const note = { noteId: "state-note", text: "Retain the work." };

await test("CLV-365 completed, unqualified and stopped Pi turns cannot accept a new input", () =>
  withScene(async (scene) => {
    const attempts = attemptsAt(scene.directory);
    assert.deepEqual(await steerPi(attempts, note), {
      delivery: "queued",
      reason: "no-open-turn",
    });
    attempts.steering.child = {
      sessionId: null,
      turn: {
        processId: null,
        launch: Promise.resolve(null),
        ended: Promise.resolve({ exitCode: 0, result: undefined }),
        stop: () => undefined,
      },
    };
    assert.deepEqual(await steerPi(attempts, note), {
      delivery: "queued",
      reason: "pi-rpc-command-unsupported",
    });
    attempts.stopping.abort();
    assert.deepEqual(await steerPi(attempts, note), {
      delivery: "queued",
      reason: "turn-stopping",
    });
  }));

await test("CLV-365 a drop during launch observation fences the pending Pi input", () =>
  withScene(async (scene) => {
    const attempts = attemptsAt(scene.directory);
    const launch = Promise.withResolvers<TurnLaunch | null>();
    const entered = Promise.withResolvers<undefined>();
    const piRpc = join(scene.directory, "rpc");
    mkdirSync(join(piRpc, "requests"), { recursive: true });
    attempts.steering.child = {
      sessionId: "session",
      turn: {
        processId: null,
        get launch() {
          entered.resolve(undefined);
          return launch.promise;
        },
        ended: Promise.resolve({ exitCode: 0, result: undefined }),
        stop: () => undefined,
      },
    };
    const pending = steerPi(attempts, note);
    await entered.promise;
    attempts.stopping.abort();
    launch.resolve({
      processId: 1,
      processStart: "unused",
      marker: "unused",
      output: "unused",
      offset: 0,
      exit: "unused",
      configuration: "unused",
      piRpc,
    });
    assert.deepEqual(await pending, {
      delivery: "queued",
      reason: "turn-stopping",
    });
    assert.deepEqual(readdirSync(join(piRpc, "requests")), []);
  }));

await test("CLV-365 three native notes retain their limit through restart and reject conflicting reuse", () =>
  withScene(async (scene) => {
    const fake = rpcFixture(scene.directory);
    const settings = { harness: { name: "pi", path: fake.program } };
    const first = scene.worker("unused", settings);
    const signal = new AbortController().signal;
    await first.deliver(intent(), signal);
    await until(() =>
      fake.requests().some((entry) => entry["type"] === "prompt"),
    );
    for (const noteId of ["one", "two", "three"])
      assert.equal(
        (await first.steer({ ...note, runId: "run-1", noteId })).delivery,
        "now",
      );
    await first.close({ turns: "keep" });
    const next = scene.worker("unused", settings);
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    assert.deepEqual(
      await next.steer({ ...note, runId: "run-1", noteId: "four" }),
      { delivery: "queued", reason: "note-limit" },
    );
    assert.deepEqual(
      await next.steer({
        ...note,
        runId: "run-1",
        noteId: "one",
        text: "Conflicting reuse",
      }),
      { delivery: "queued", reason: "pi-rpc-note-conflict" },
    );
    const launch = field(record(scene, "operation-1/started.json"), "launch");
    const requests = join(String(field(launch, "piRpc")), "requests");
    writeFileSync(join(requests, "invalid"), "{}");
    assert.deepEqual(await next.steer({ ...note, runId: "run-1" }), {
      delivery: "queued",
      reason: "pi-rpc-evidence-unreadable",
    });
    assert.equal(
      fake.requests().filter((entry) => entry["type"] === "steer").length,
      3,
    );
  }));
