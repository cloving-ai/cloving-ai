import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import {
  alive,
  field,
  record,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { runningPi, prompts } from "./pi-native-resume-fixture.ts";
import {
  attachedProcess,
  launchState,
} from "../src/daemon/detached-process.ts";

await test("CLV-365 forced Pi launcher loss without an owned exit refuses another prompt", () =>
  withScene(async (scene) => {
    const { first, launch, settings, call, signal, session } =
      await runningPi(scene);
    await first.close({ turns: "keep" });
    assert.equal(await launchState(launch), "running");
    attachedProcess(launch).signal("SIGKILL");
    await until(() => !alive(launch.processId));
    assert.equal(existsSync(launch.exit), false);
    const reply = await scene
      .worker("unused", settings)
      .reconcile(call, signal);
    assert.equal(reply.kind, "unknown", JSON.stringify(reply));
    assert.match(
      String(field(reply, "evidence")),
      /^pi-prior-result-uncertain:/,
    );
    assert.equal(record(scene, "operation-1/attempt-2.json"), undefined);
    assert.deepEqual(
      field(record(scene, "operation-1/started.json"), "piSession"),
      session,
    );
    assert.equal(prompts(scene).length, 1);
  }));
