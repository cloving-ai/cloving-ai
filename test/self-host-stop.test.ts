import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { hostedPrograms } from "../tools/self-host-processes.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { reached } from "./self-host-fixture.ts";
import {
  programs,
  stopFixturePrograms,
} from "./self-host-processes-fixture.ts";
import { withUpdateRepository } from "./self-update-git-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

afterEach(() => {
  mock.restoreAll();
});

for (const signal of ["SIGINT", "SIGTERM"])
  for (const stuck of ["watch", "daemon"])
    await test(`CLV-259 ${signal} kills a stuck ${stuck} after the stop limit`, async () => {
      await withFiles({}, async (root) => {
        const paths = await programs(root, { stuckPrograms: [stuck] });
        const stopMilliseconds = testMilliseconds(100);
        const settings = {
          ...paths,
          repository: root,
          runtime: join(root, "host/run"),
          directory: join(root, "host"),
          watchPort: "3663",
          phoneRelay: "off",
          updateMilliseconds: undefined,
          stopMilliseconds,
        };
        const observed = observedStop();
        const hosting = hostedPrograms(settings);
        try {
          await ready(root, ["daemon", "watch"]);
          const interruptedAt = Date.now();
          process.emit(signal);
          assert.equal(
            await boundedStatus(hosting, stopMilliseconds),
            stuck === "daemon" ? 1 : 0,
            "hostedPrograms did not return within the stop limit plus 5 seconds",
          );
          assert.ok(Date.now() - interruptedAt >= stopMilliseconds);
          assert.deepEqual(observed.signals, [signal, signal, "SIGKILL"]);
          for (const name of ["daemon", "watch"])
            assert.equal(
              await readFile(join(root, `${name}-signals`), "utf8"),
              `${signal}\n`,
            );
          assert.deepEqual(observed.errors, [
            `Cloving stopped the ${stuck} child with SIGKILL after ${String(stopMilliseconds / 1000)} s\n`,
          ]);
        } finally {
          await stopFixturePrograms(root);
          await hosting;
        }
      });
    });

await test("CLV-259 self-update kills a stuck watch before the fast-forward", async () => {
  await withUpdateRepository(async ({ root, repository, git, target }) => {
    const paths = await programs(root, { stuckPrograms: ["watch"] });
    const stopMilliseconds = testMilliseconds(100);
    const observed = observedStop();
    const hosting = hostedPrograms({
      ...paths,
      repository,
      runtime: join(root, "host/run"),
      directory: join(root, "host"),
      watchPort: "3663",
      phoneRelay: "off",
      updateMilliseconds: testMilliseconds(300),
      stopMilliseconds,
    });
    try {
      assert.equal(await boundedStatus(hosting, stopMilliseconds), 75);
      assert.equal(git(["rev-parse", "HEAD"]), target);
      assert.equal(
        await readFile(join(root, "daemon-stopped"), "utf8"),
        "stopped",
      );
      assert.equal(
        await readFile(join(root, "watch-signals"), "utf8"),
        "SIGTERM\n",
      );
      assert.deepEqual(observed.signals, ["SIGTERM", "SIGTERM", "SIGKILL"]);
      assert.deepEqual(observed.errors, [
        `Cloving stopped the watch child with SIGKILL after ${String(stopMilliseconds / 1000)} s\n`,
      ]);
    } finally {
      await stopFixturePrograms(root);
      await hosting;
    }
  });
});

await test("CLV-259 the host uses a 60-second default stop limit for every open child", async () => {
  await withFiles({}, async (root) => {
    const names = ["daemon", "watch", "relay"];
    const paths = await programs(root, { stuckPrograms: names });
    const observed = observedStop();
    const hosting = hostedPrograms({
      ...paths,
      repository: root,
      runtime: join(root, "host/run"),
      directory: join(root, "host"),
      watchPort: "3663",
      phoneRelay: "on",
      updateMilliseconds: undefined,
    });
    try {
      await ready(root, names);
      const timers: Array<{
        readonly run: () => void;
        readonly milliseconds: number;
      }> = [];
      const timeout = globalThis.setTimeout;
      mock.method(
        globalThis,
        "setTimeout",
        (run: () => void, milliseconds = 1) => {
          const handle = timeout(() => undefined, 1);
          clearTimeout(handle);
          timers.push({ run, milliseconds });
          return handle;
        },
      );
      process.emit("SIGTERM");
      assert.deepEqual(
        timers.map((timer) => timer.milliseconds),
        names.map(() => 60000),
      );
      assert.deepEqual(
        observed.signals,
        names.map(() => "SIGTERM"),
      );
      for (const timer of timers) timer.run();
      assert.deepEqual(observed.signals, [
        ...names.map(() => "SIGTERM"),
        ...names.map(() => "SIGKILL"),
      ]);
      assert.equal(await boundedStatus(hosting, 0), 1);
      assert.deepEqual(
        observed.errors,
        names.map(
          (name) =>
            `Cloving stopped the ${name} child with SIGKILL after 60 s\n`,
        ),
      );
    } finally {
      await stopFixturePrograms(root);
      await hosting;
    }
  });
});

function observedStop() {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const errors: string[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(
    childProcess.ChildProcess.prototype,
    "kill",
  );
  const kill: unknown = descriptor?.value;
  assert.ok(typeof kill === "function");
  mock.method(process.stderr, "write", (line: string | Uint8Array) => {
    errors.push(String(line));
    return true;
  });
  mock.method(
    childProcess.ChildProcess.prototype,
    "kill",
    function (
      this: childProcess.ChildProcess,
      signal?: NodeJS.Signals | number,
    ) {
      signals.push(signal);
      return Reflect.apply(kill, this, [signal]) === true;
    },
  );
  return { signals, errors };
}

async function ready(root: string, names: readonly string[]): Promise<void> {
  for (const name of names)
    await reached(() =>
      readFile(join(root, `${name}-ready`)).catch(() => undefined),
    );
}

async function boundedStatus(
  hosting: Promise<number>,
  milliseconds: number,
): Promise<number | string> {
  const deadline = new AbortController();
  try {
    return await Promise.race([
      hosting,
      delay(milliseconds + testMilliseconds(5000), "timed out", {
        signal: deadline.signal,
      }),
    ]);
  } finally {
    deadline.abort();
  }
}
