import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  field,
  intent,
  record,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { fakePi } from "./pi-fixture.ts";

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
