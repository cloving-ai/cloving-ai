import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  submitPiRpcNote,
  piRpcNoteReceipt,
} from "../src/daemon/pi-rpc-channel.ts";
import { recordedLaunch } from "../src/turn-launch.ts";
import { rpcFixture } from "./pi-rpc-fixture.ts";
import {
  alive,
  field,
  intent,
  record,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

await test("CLV-365 missing or corrupt RPC requests refuse recovery with a typed reason", async () => {
  for (const state of ["missing", "corrupt"])
    await withScene(async (scene) => {
      const fake = rpcFixture(scene.directory);
      const settings = { harness: { name: "pi", path: fake.program } };
      const first = scene.worker("unused", settings);
      const signal = new AbortController().signal;
      await first.deliver(intent(), signal);
      await until(() =>
        fake.requests().some((entry) => entry["type"] === "prompt"),
      );
      const launch = recordedLaunch(
        field(record(scene, "operation-1/started.json"), "launch"),
      );
      assert.ok(launch?.piRpc);
      await first.close({ turns: "keep" });
      const requests = join(launch.piRpc, "requests");
      process.kill(launch.processId, "SIGSTOP");
      try {
        if (state === "missing") rmSync(requests, { recursive: true });
        if (state === "corrupt")
          writeFileSync(join(requests, "unknown.json"), "{}");
        const next = scene.worker("unused", settings);
        const reply = await next.reconcile(intent(), signal);
        assert.equal(reply.kind, "unknown");
        assert.match(
          String(field(reply, "evidence")),
          /pi-rpc-ownership-conflict/,
        );
        assert.equal(alive(launch.processId), true);
      } finally {
        mkdirSync(requests, { recursive: true });
        rmSync(join(requests, "unknown.json"), { force: true });
        process.kill(launch.processId, "SIGCONT");
        writeFileSync(fake.gate, "settle");
        await until(() => !alive(launch.processId));
      }
    });
});

await test("CLV-365 a released observer cannot submit after its process identity lookup", () =>
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
    const released = new AbortController();
    const owner = { ...launch, piRpc: launch.piRpc, inactive: released.signal };
    const stale = submitPiRpcNote(owner, {
      noteId: "stale",
      text: "Old observer",
      sequence: 1,
    });
    released.abort();
    assert.deepEqual(await stale, {
      status: "unavailable",
      reason: "pi-rpc-observer-released",
    });
    const current = { ...launch, piRpc: launch.piRpc };
    const note = { noteId: "current", text: "Current observer", sequence: 1 };
    await submitPiRpcNote(current, note);
    await until(
      async () => (await piRpcNoteReceipt(current, note)).status === "observed",
    );
    assert.equal(
      fake.requests().filter((entry) => entry["type"] === "steer").length,
      1,
    );
    writeFileSync(fake.gate, "settle");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
  }));
