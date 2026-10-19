import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseCheckTimeFactor } from "../quality/test-execution.ts";
import type { Authority } from "../src/broker/actor/authority.ts";
import {
  deliverUntil,
  fastTiming,
  openedAuthority,
} from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
  withChild,
} from "./authority-store-fixture.ts";
import { digestOf } from "./digest-fixture.ts";
import { effectRequest, noon, sender } from "./effect-fixture.ts";
import {
  launchCalls,
  launches,
  launchingDelivery,
  workerName,
} from "./effect-launch-fixture.ts";

after(removeTemporaryDirectories);

const request = effectRequest({ commandId: "c-request", round: 1 });
const { operationId } = request;
const name = workerName(operationId);
const workers: number[] = [];

after(() => {
  for (const pid of workers)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function workerPid(directory: string): number {
  const [launch] = launches(directory);
  assert.ok(launch);
  const pid = Number(launch.worker.replace("worker-", ""));
  workers.push(pid);
  return pid;
}

function digests(directory: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    readdirSync(directory)
      .filter((file) => file.startsWith(name) || file.startsWith("launch"))
      .sort()
      .map((file) => [
        file,
        createHash("sha256")
          .update(readFileSync(join(directory, file)))
          .digest("hex"),
      ]),
  );
}

async function killedAfterLaunch(directory: string): Promise<void> {
  await withChild(
    { script: "effect-child.ts", parameters: [directory, "launch-then-stop"] },
    async (child) => {
      assert.deepEqual(await child.exited, { code: null, signal: "SIGKILL" });
    },
  );
}

function recovered(directory: string): Promise<Authority> {
  return openedAuthority(directory, {
    delivery: launchingDelivery(directory),
    clock: () => noon,
    timing: fastTiming,
  });
}

function until(authority: Authority, status: string): Promise<void> {
  return deliverUntil(
    authority,
    async () =>
      (await authority.effects.operation(operationId))?.status === status,
  );
}

await test("CLV-049 a controller kill between the launch of a fake child and its receipt gives one logical launch after the restart, also with a changed transport call ID", async () => {
  const directory = await temporaryDirectory();
  await killedAfterLaunch(directory);
  const pid = workerPid(directory);
  assert.equal(alive(pid), true);
  assert.equal(launches(directory).length, 1);
  assert.deepEqual(launchCalls(directory), [name]);
  const authority = await recovered(directory);
  const before = await authority.effects.operation(operationId);
  assert.deepEqual(
    [before?.status, before?.receipt],
    ["dispatch-pending", null],
  );
  const retry = effectRequest({
    commandId: "c-request-after-restart",
    round: 1,
    transport: "sdk-retry-2 of tool-call-7",
  });
  const again = await sender(authority, { now: noon })(
    retry.command,
    retry.documents,
  );
  assert.equal(Reflect.get(again, "disposition"), "existing");
  await until(authority, "running");
  const operation = await authority.effects.operation(operationId);
  assert.deepEqual(
    [operation?.receipt, operation?.worker, operation?.attempts],
    [`launch-${name}`, `worker-${String(pid)}`, 0],
  );
  assert.deepEqual(
    launches(directory).map((launch) => launch.name),
    [name],
  );
  assert.deepEqual(launchCalls(directory), [name]);
  assert.equal(alive(pid), true);
  await authority.close();
});

await test("CLV-049 a result that the fake child completed before the kill counts one time after the restart, and the files of the child stay", async () => {
  const directory = await temporaryDirectory();
  await killedAfterLaunch(directory);
  const pid = workerPid(directory);
  writeFileSync(join(directory, `${name}.finish`), "");
  for (let waited = 0; alive(pid) && waited < 5_000; waited += 20)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(alive(pid), false);
  const before = digests(directory);
  assert.deepEqual(Object.keys(before), [
    `${name}.finish`,
    `${name}.input`,
    `${name}.result`,
    "launch-calls.log",
    "launch.log",
  ]);
  const first = await recovered(directory);
  await until(first, "completed");
  await first.close();
  const second = await recovered(directory);
  await deliverUntil(
    second,
    async () => (await second.eligibleIntents()).length === 0,
  );
  const operation = await second.effects.operation(operationId);
  assert.deepEqual(
    [operation?.status, operation?.result],
    ["completed", digestOf("result of " + digestOf("build the package"))],
  );
  assert.equal(
    (await second.events()).filter(
      (event) => event.type === "operation.reconciled",
    ).length,
    1,
  );
  assert.deepEqual(digests(directory), before);
  assert.deepEqual(launchCalls(directory), [name]);
  assert.equal(launches(directory).length, 1);
  await second.close();
});

await test("CLV-049 the fake worker of the launch tests ends with an error and writes no file when it gets no arguments", async () => {
  const directory = await temporaryDirectory();
  const worker = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "effect-worker.ts")],
    {
      cwd: directory,
      encoding: "utf8",
      timeout:
        5_000 * parseCheckTimeFactor(process.env["CLOVING_CHECK_TIME_FACTOR"]),
    },
  );
  assert.equal(worker.status, 1);
  assert.match(worker.stderr, /missing-worker-arguments/);
  assert.deepEqual(readdirSync(directory), []);
});
