import assert from "node:assert/strict";
import { existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { recordedLaunch } from "../src/turn-launch.ts";
import { receivedNotes } from "../src/daemon/turn-notes.ts";
import {
  submitPiRpcNote,
  piRpcNoteReceipt,
} from "../src/daemon/pi-rpc-channel.ts";
import { fakeEngine, fakeSandbox } from "./claude-runner-fixture.ts";
import type { WorkerOverrides } from "./claude-worker-fixture.ts";
import { rpcFixture } from "./pi-rpc-fixture.ts";
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

await test("CLV-365 native RPC restart retains the input owner and one prompt", () =>
  withScene(async (scene) => {
    const fake = rpcFixture(scene.directory, {
      replay: true,
    });
    const settings = {
      harness: { name: "pi", path: fake.program },
      tokenPrices: {
        "test-provider/test-model": { input: 2, cachedInput: 0.5, output: 8 },
      },
    };
    const first = scene.worker("unused", settings);
    const signal = new AbortController().signal;
    await first.deliver(intent(), signal);
    const started = record(scene, "operation-1/started.json");
    const launch = field(started, "launch");
    assert.equal(typeof field(launch, "piRpc"), "string");
    await until(() =>
      fake.requests().some((entry) => entry["type"] === "prompt"),
    );
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
    assert.deepEqual(
      field(record(scene, "operation-1/started.json"), "launch"),
      launch,
    );
    writeFileSync(fake.gate, "settle");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(
      fake.requests().filter((entry) => entry["type"] === "prompt").length,
      1,
    );
    assert.equal(resultOf(scene.reports[0].result)["turns"], 1);
    assert.equal(
      resultOf(scene.reports[0].result)["estimatedCostUsd"],
      0.00038,
    );
    assert.equal(existsSync(String(field(launch, "piRpc"))), true);
  }));

await test("CLV-365 native RPC refuses stale session ownership before any prompt", () =>
  withScene(async (scene) => {
    const fake = rpcFixture(scene.directory, {
      foreignSession: "stale-session",
    });
    const worker = scene.worker("unused", {
      harness: { name: "pi", path: fake.program },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "failed");
    assert.equal(scene.reports[0].reason, "pi-rpc-session-conflict");
    assert.equal(
      fake.requests().filter((entry) => entry["type"] === "prompt").length,
      0,
    );
  }));

await test("CLV-365 native Pi steering reaches the surviving input once and waits for settlement", () =>
  withScene(async (scene) => {
    const fake = rpcFixture(scene.directory);
    const settings = { harness: { name: "pi", path: fake.program } };
    const worker = scene.worker("unused", settings);
    const signal = new AbortController().signal;
    await worker.deliver(intent(), signal);
    await until(() =>
      fake.requests().some((entry) => entry["type"] === "prompt"),
    );
    const launch = field(record(scene, "operation-1/started.json"), "launch");
    const note = {
      runId: "run-1",
      noteId: "native-note",
      text: "Retain previous work.",
    };
    assert.deepEqual(await worker.steer(note), {
      delivery: "now",
      operationId: "operation-1",
    });
    await worker.close({ turns: "keep" });
    const next = scene.worker("unused", settings);
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    assert.deepEqual(await next.steer(note), {
      delivery: "now",
      operationId: "operation-1",
    });
    assert.equal(
      fake.requests().filter((entry) => entry["type"] === "steer").length,
      1,
    );
    assert.equal(
      fake.requests().filter((entry) => entry["type"] === "prompt").length,
      1,
    );
    assert.equal(alive(Number(field(launch, "processId"))), true);
    assert.equal(scene.reports.length, 0);
    writeFileSync(fake.gate, "settle");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(
      field(record(scene, "operation-1/started.json"), "attempt"),
      1,
    );
  }));

await test("CLV-365 a lost steering callback cannot make the next turn consume the same note", () =>
  withScene(async (scene) => {
    const fake = rpcFixture(scene.directory);
    const settings = { harness: { name: "pi", path: fake.program } };
    const worker = scene.worker("unused", settings);
    await worker.deliver(intent(), new AbortController().signal);
    await until(() =>
      fake.requests().some((entry) => entry["type"] === "prompt"),
    );
    const launch = recordedLaunch(
      field(record(scene, "operation-1/started.json"), "launch"),
    );
    assert.ok(launch?.piRpc);
    const owner = { ...launch, piRpc: launch.piRpc };
    const note = { noteId: "lost-callback", text: "Once only.", sequence: 1 };
    await submitPiRpcNote(owner, note);
    await until(
      async () => (await piRpcNoteReceipt(owner, note)).status === "observed",
    );
    assert.deepEqual(await receivedNotes(scene.journal, ["operation-1"]), {
      "lost-callback": "operation-1",
    });
    writeFileSync(fake.gate, "settle");
    await until(() => scene.reports.length === 1);
  }));

await test("CLV-365 recovery refuses missing or foreign RPC ownership without adopting or stopping its process", async () => {
  for (const evidence of [
    undefined,
    { protocol: "pi-1.5.2", marker: "foreign" },
  ])
    await withScene(async (scene) => {
      const fake = rpcFixture(scene.directory);
      const settings = { harness: { name: "pi", path: fake.program } };
      const worker = scene.worker("unused", settings);
      const signal = new AbortController().signal;
      await worker.deliver(intent(), signal);
      await until(() =>
        fake.requests().some((entry) => entry["type"] === "prompt"),
      );
      const launch = recordedLaunch(
        field(record(scene, "operation-1/started.json"), "launch"),
      );
      assert.ok(launch?.piRpc);
      await worker.close({ turns: "keep" });
      const path = join(launch.piRpc, "owner.json");
      if (evidence === undefined) unlinkSync(path);
      if (evidence !== undefined) writeFileSync(path, JSON.stringify(evidence));
      const reply = await scene
        .worker("unused", settings)
        .reconcile(intent(), signal);
      assert.equal(reply.kind, "unknown");
      assert.match(
        String(field(reply, "evidence")),
        /pi-rpc-ownership-conflict/,
      );
      assert.equal(alive(launch.processId), true);
      assert.equal(
        fake.requests().filter((entry) => entry["type"] === "prompt").length,
        1,
      );
      writeFileSync(fake.gate, "settle");
      await until(() => !alive(launch.processId));
    });
});

for (const kind of ["host", "shell", "container", "seatbelt"] as const)
  await test(`CLV-365 native RPC ${kind} runner keeps one input owner through steering and drop`, () =>
    withScene(async (scene) => {
      const fake = rpcFixture(scene.directory);
      const settings = runnerSettings(scene, { kind, path: fake.program });
      const call = intent({ method: "run-turn:native" });
      const signal = new AbortController().signal;
      const first = scene.worker("unused", settings);
      await first.deliver(call, signal);
      await until(() =>
        fake.requests().some((entry) => entry["type"] === "prompt"),
      );
      const launch = field(record(scene, "operation-1/started.json"), "launch");
      const processId = Number(
        resultOf(readFileSync(fake.processFile, "utf8"))["processId"],
      );
      await first.close({ turns: "keep" });
      const next = scene.worker("unused", settings);
      assert.equal((await next.reconcile(call, signal)).kind, "accepted");
      assert.deepEqual(
        field(record(scene, "operation-1/started.json"), "launch"),
        launch,
      );
      assert.equal(alive(processId), true);
      assert.equal(
        (
          await next.steer({
            runId: "run-1",
            noteId: "runner-note",
            text: "Retain the work.",
          })
        ).delivery,
        "now",
      );
      assert.equal((await next.stop(call, signal)).kind, "stopped");
      assert.equal(alive(processId), false);
      assert.equal(alive(Number(field(launch, "processId"))), false);
      assert.equal(
        fake.requests().filter((entry) => entry["type"] === "prompt").length,
        1,
      );
      assert.equal(
        fake.requests().filter((entry) => entry["type"] === "steer").length,
        1,
      );
      assert.equal((await next.reconcile(call, signal)).kind, "stopped");
    }));

await test("CLV-365 a note queued before RPC readiness reaches exactly one later eligible turn", () =>
  withScene(async (scene) => {
    const readyGate = join(scene.directory, "ready");
    const fake = rpcFixture(scene.directory, {
      readyGate,
    });
    const notes: { noteId: string; text: string }[] = [];
    const settings = {
      harness: { name: "pi", path: fake.program },
      notes: {
        read: () => Promise.resolve(notes),
        operations: () =>
          Promise.resolve(["operation-1", "operation-2", "operation-3"]),
      },
    };
    const worker = scene.worker("unused", settings);
    const signal = new AbortController().signal;
    await worker.deliver(intent(), signal);
    await until(() =>
      fake.requests().some((entry) => entry["type"] === "get_state"),
    );
    const note = { noteId: "early", text: "Apply this later." };
    notes.push(note);
    assert.deepEqual(await worker.steer({ ...note, runId: "run-1" }), {
      delivery: "queued",
      reason: "pi-rpc-not-running",
    });
    writeFileSync(readyGate, "ready");
    await until(() =>
      fake.requests().some((entry) => entry["type"] === "prompt"),
    );
    writeFileSync(fake.gate, "settle");
    await until(() => scene.reports.length === 1);
    await worker.deliver(intent({ operationId: "operation-2" }), signal);
    await until(() => scene.reports.length === 2);
    await worker.deliver(intent({ operationId: "operation-3" }), signal);
    await until(() => scene.reports.length === 3);
    const prompts = fake
      .requests()
      .filter((entry) => entry["type"] === "prompt");
    assert.equal(prompts.length, 3);
    assert.equal(
      prompts.filter((entry) => String(entry["message"]).includes(note.text))
        .length,
      1,
    );
    assert.equal(
      fake.requests().filter((entry) => entry["type"] === "steer").length,
      0,
    );
  }));

await test("CLV-365 a lost native steering reply stays reserved without replacement work", () =>
  withScene(async (scene) => {
    const fake = rpcFixture(scene.directory, { omitSteerReply: true });
    const worker = scene.worker("unused", {
      harness: { name: "pi", path: fake.program },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() =>
      fake.requests().some((entry) => entry["type"] === "prompt"),
    );
    const outcome = await worker.steer({
      runId: "run-1",
      noteId: "lost-native-reply",
      text: "Do this once.",
    });
    assert.deepEqual(outcome, {
      delivery: "queued",
      reason: "pi-rpc-delivery-uncertain",
    });
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.reason, "pi-rpc-delivery-uncertain");
    assert.deepEqual(await receivedNotes(scene.journal, ["operation-1"]), {
      "lost-native-reply": "operation-1",
    });
    assert.equal(
      fake.requests().filter((entry) => entry["type"] === "prompt").length,
      1,
    );
    assert.equal(
      fake.requests().filter((entry) => entry["type"] === "steer").length,
      1,
    );
  }));

function runnerSettings(
  scene: Scene,
  selected: { readonly kind: string; readonly path: string },
): WorkerOverrides {
  const { kind, path } = selected;
  const harness = { name: "pi", path };
  if (kind === "container")
    return {
      harness,
      profiles: {
        native: {
          harness: "pi",
          runner: {
            kind,
            engine: fakeEngine(scene.directory, { access: "write" }).path,
            image: "fixture",
          },
        },
      },
    };
  if (kind === "seatbelt")
    return {
      harness,
      profiles: {
        native: {
          harness: "pi",
          runner: { kind, command: fakeSandbox(scene.directory).path },
        },
      },
    };
  if (kind !== "shell")
    return { harness, profiles: { native: { harness: "pi" } } };
  writeFileSync(
    join(scene.directory, ".zshrc"),
    `pi_function() { '${path}' "$@"; }\n`,
  );
  return {
    harness: {
      name: "pi",
      kind: "shell",
      command: ["pi_function", "--mode", "json"],
    },
    shell: "/bin/zsh",
    profiles: { native: { harness: "pi", env: { ZDOTDIR: scene.directory } } },
  };
}
