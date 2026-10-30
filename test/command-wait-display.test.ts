import { readWaitStatus, shownWait } from "./command-wait-display-fixture.ts";
import { shownCommandWaits } from "../src/cli/command-waits.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { commandWaitHost } from "./command-wait-host-fixture.ts";
import {
  field,
  items,
  parsed,
  startedRun,
  eventually,
  withHarness,
} from "./service-fixture.ts";

await test("CLV-238 plain status shows an open command wait beside its ordinary budget", () =>
  withHarness(async (harness) => {
    const scene = await commandWaitHost(harness);
    await scene.ordinary(1);
    assert.equal(
      (await scene.ports.commandWait.open(scene.opening)).kind,
      "accepted",
    );
    scene.clock.now += 5 * 86_400_000;
    await scene.ports.commandWait.check({
      ...scene.request,
      commandId: "check",
    });
    await eventually(async () =>
      (await scene.ports.commandWait.read(scene.request))?.checkCount === 1 &&
      (await scene.ports.commandWait.read(scene.request))
        ?.lastCheckSettledAt === scene.clock.now
        ? true
        : undefined,
    );
    const plain = await harness.cli(["status", scene.runId]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(
      plain.stdout,
      /Command wait team-review · review-state · waiting · 2160000 s left/,
    );
    assert.match(plain.stdout, /deadline \S+ · next check \S+ · checks 1/);
    assert.match(plain.stdout, /^Effects: 1 of 2$/m);
  }));

await test("CLV-238 status JSON includes the full declared allowance before a wait starts", () =>
  withHarness(async (harness) => {
    const scene = await commandWaitHost(harness);
    const json = await harness.cli(["status", scene.runId, "--json"]);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(field(field(parsed(json), "run"), "commandWaits"), [
      {
        name: "team-review",
        command: "review-state",
        state: "not-started",
        maximumWaitSeconds: 2_592_000,
        startedAt: null,
        deadline: null,
        nextCheckAt: null,
        checkCount: 0,
        remainingSeconds: 2_592_000,
        reason: null,
      },
    ]);
    assert.deepEqual((await readWaitStatus(harness, scene.runId))["budget"], {
      spent: 0,
      limit: 2,
    });
  }));

await test("CLV-238 remaining seconds round up, reach zero and remain zero past the deadline", () =>
  withHarness(async (harness) => {
    const scene = await commandWaitHost(harness);
    await scene.ports.commandWait.open(scene.opening);
    const wait = await scene.ports.commandWait.read(scene.request);
    assert.ok(wait);
    for (const [now, remaining] of [
      [wait.startedAt + 5 * 86_400_000, 2_160_000],
      [wait.deadline - 1001, 2],
      [wait.deadline - 1, 1],
      [wait.deadline, 0],
      [wait.deadline + 86_400_000, 0],
    ]) {
      assert.ok(now !== undefined && remaining !== undefined);
      scene.clock.now = now;
      const status = await readWaitStatus(harness, scene.runId);
      assert.equal(
        field(items(status["commandWaits"])[0], "remainingSeconds"),
        remaining,
      );
      assert.deepEqual(status["budget"], { spent: 0, limit: 2 });
    }
  }));

await test("CLV-238 early settlement freezes the allowance and hides command input and output", () =>
  withHarness(async (harness) => {
    const scene = await commandWaitHost(harness);
    await scene.ports.commandWait.open({
      ...scene.opening,
      input: '{"private":"wait-input-fixture"}',
    });
    scene.clock.now += 5 * 86_400_000 + 1;
    scene.clock.output = '{"ready":true,"value":"wait-output-fixture"}';
    await scene.ports.commandWait.check({
      ...scene.request,
      commandId: "ready",
    });
    await eventually(async () =>
      (await scene.ports.commandWait.read(scene.request))?.state === "completed"
        ? true
        : undefined,
    );
    const before = await readWaitStatus(harness, scene.runId);
    assert.equal(
      field(items(before["commandWaits"])[0], "remainingSeconds"),
      2_160_000,
    );
    scene.clock.now += 10 * 86_400_000;
    const after = await readWaitStatus(harness, scene.runId);
    assert.deepEqual(after["commandWaits"], before["commandWaits"]);
    const json = await harness.cli(["status", scene.runId, "--json"]);
    const plain = await harness.cli(["status", scene.runId]);
    for (const result of [json, plain]) {
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(
        result.stdout,
        /wait-input-fixture|wait-output-fixture|inputDigest|commandOutput/,
      );
    }
  }));

await test("CLV-238 failed waits retain their reason and stopped clock across restart", () =>
  withHarness(async (harness) => {
    const scene = await commandWaitHost(harness);
    await scene.ports.commandWait.open(scene.opening);
    scene.clock.now += 10_001;
    scene.clock.output = "wait-stdout-fixture wait-stderr-fixture";
    await scene.ports.commandWait.check({
      ...scene.request,
      commandId: "failed",
    });
    await eventually(async () =>
      (await scene.ports.commandWait.read(scene.request))?.state === "failed"
        ? true
        : undefined,
    );
    const before = await readWaitStatus(harness, scene.runId);
    const wait = items(before["commandWaits"])[0];
    assert.equal(field(wait, "reason"), "command-wait-invalid-output");
    assert.equal(field(wait, "remainingSeconds"), 2_591_990);
    assert.equal(field(wait, "nextCheckAt"), null);
    await scene.service.close();
    scene.clock.now += 86_400_000;
    await harness.start(scene.settings);
    assert.deepEqual(
      (await readWaitStatus(harness, scene.runId))["commandWaits"],
      before["commandWaits"],
    );
    const plain = await harness.cli(["status", scene.runId]);
    assert.match(plain.stdout, /command-wait-invalid-output/);
    assert.doesNotMatch(
      plain.stdout,
      /wait-stdout-fixture|wait-stderr-fixture/,
    );
  }));

await test("CLV-238 a run with no declared waits has no wait section", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const runId = await startedRun(harness, { service, commandId: "plain" });
    assert.deepEqual(
      (await readWaitStatus(harness, runId))["commandWaits"],
      [],
    );
    const plain = await harness.cli(["status", runId]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.doesNotMatch(plain.stdout, /Command wait/);
  }));

await test("CLV-238 wait display accepts only wait metadata and ignores malformed entries", () => {
  for (const value of [undefined, null, "wait", {}, [null], [{}]])
    assert.deepEqual(shownCommandWaits(value), []);
  for (const name of [
    "name",
    "command",
    "state",
    "maximumWaitSeconds",
    "remainingSeconds",
    "checkCount",
  ]) {
    assert.deepEqual(
      shownCommandWaits([{ ...shownWait, [name]: undefined }]),
      [],
    );
  }
  assert.deepEqual(
    shownCommandWaits([
      {
        ...shownWait,
        startedAt: null,
        deadline: null,
        nextCheckAt: null,
        input: "wait-input-fixture",
        stdout: "wait-stdout-fixture",
        stderr: "wait-stderr-fixture",
      },
    ]),
    [{ ...shownWait, startedAt: null, deadline: null, nextCheckAt: null }],
  );
});
