import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { resultOf, withScene, until } from "./claude-worker-fixture.ts";
import { startRpcFixture } from "./pi-rpc-fixture.ts";

await test("CLV-365 RPC launches a large prompt from its private plan without argv payload", () =>
  withScene(async (scene) => {
    const prompt = "private prompt 🐈\n".repeat(16_384);
    const { fake, turn, owner, ending } = await startRpcFixture(scene, {
      prompt,
    });
    try {
      const plan = join(owner.piRpc, "plan.json");
      assert.equal(turn.child.spawnargs.includes(plan), true);
      assert.equal(
        turn.child.spawnargs.some((argument) => argument.includes(prompt)),
        false,
      );
      assert.equal(statSync(plan).mode & 0o777, 0o600);
      assert.equal(resultOf(readFileSync(plan, "utf8"))["prompt"], prompt);
      await until(() =>
        fake.requests().some((request) => request["type"] === "prompt"),
      );
      const prompts = fake
        .requests()
        .filter((request) => request["type"] === "prompt");
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0]?.["message"], prompt);
      writeFileSync(fake.gate, "settle");
      const end = await ending;
      assert.ok(typeof end !== "string");
      assert.equal(end.exitCode, 0);
      assert.equal(end.reason, undefined);
      assert.equal(
        fake.requests().filter((request) => request["type"] === "prompt")
          .length,
        1,
      );
    } finally {
      turn.signal("SIGKILL");
      await ending;
    }
  }));

function importBarrier(directory: string) {
  const ready = join(directory, "stop-handled");
  const gate = join(directory, "module-gate");
  const evaluated = join(directory, "module-evaluated");
  const preload = join(directory, "preload.mjs");
  writeFileSync(
    preload,
    `import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const originalOn = process.on;
let stopHandler;
process.on = function (name, handler) {
  if (name === "SIGTERM") stopHandler = handler;
  return originalOn.call(this, name, handler);
};
const originalThen = Promise.prototype.then;
Promise.prototype.then = function (fulfilled, rejected) {
  if (stopHandler && typeof fulfilled === "function" && fulfilled.toString().includes("attachPiRpc")) {
    stopHandler();
    writeFileSync(${JSON.stringify(ready)}, "handled");
    return originalThen.call(this, async (module) => {
      writeFileSync(${JSON.stringify(evaluated)}, "evaluated");
      while (!existsSync(${JSON.stringify(gate)})) await delay(10);
      return fulfilled(module);
    }, rejected);
  }
  return originalThen.call(this, fulfilled, rejected);
};
`,
  );
  return { ready, gate, evaluated, preload };
}

await test("CLV-365 a stop handler during RPC module startup cannot send the first prompt", () =>
  withScene(async (scene) => {
    const barrier = importBarrier(scene.directory);
    const { fake, turn, owner, ending } = await startRpcFixture(scene, {
      environment: {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(barrier.preload).href}`,
      },
    });
    try {
      await until(
        () => existsSync(barrier.ready) && existsSync(barrier.evaluated),
      );
      assert.equal(existsSync(join(owner.piRpc, "owner.json")), false);
      writeFileSync(barrier.gate, "release");
      await until(
        () =>
          existsSync(join(scene.directory, "exit.json")) ||
          fake.requests().some((request) => request["type"] === "prompt"),
      );
      assert.equal(
        fake.requests().filter((request) => request["type"] === "prompt")
          .length,
        0,
      );
      const end = await ending;
      assert.ok(typeof end !== "string");
      assert.equal(end.reason, "pi-rpc-stopped-before-input");
      assert.equal(
        fake.requests().filter((request) => request["type"] === "prompt")
          .length,
        0,
      );
    } finally {
      writeFileSync(barrier.gate, "release");
      turn.signal("SIGKILL");
    }
  }));
