import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { HostProcesses } from "../tools/self-host-processes.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  programs,
  stopFixturePrograms,
  type WatchExit,
} from "./self-host-processes-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const fastMilliseconds = testMilliseconds(2000);
const policy = {
  delayMilliseconds: 10,
  fastMilliseconds,
  limit: 5,
  windowMilliseconds: 600_000,
};

async function restartedHost(
  root: string,
  scene: {
    readonly exits: readonly WatchExit[];
    readonly lastStart: number;
    readonly policy?: HostProcesses["watchRestart"];
  },
) {
  const paths = await programs(root, {
    daemonMilliseconds: 300,
    readyPrograms: [`watch-${String(scene.lastStart)}`],
    watchExits: scene.exits,
  });
  const settings: HostProcesses = {
    ...paths,
    repository: root,
    runtime: join(root, "host/run"),
    directory: join(root, "host"),
    watchPort: "3663",
    phoneRelay: "off",
    updateMilliseconds: undefined,
    watchRestart: scene.policy ?? policy,
  };
  const entry = join(root, "restart-host.mjs");
  await writeFile(
    entry,
    `import { hostedPrograms } from ${JSON.stringify(pathToFileURL(resolve("tools/self-host-processes.ts")).href)};
process.exitCode = await hostedPrograms(${JSON.stringify(settings)});`,
  );
  try {
    const result = spawnSync(process.execPath, [entry], {
      encoding: "utf8",
      timeout: testMilliseconds(30_000),
      killSignal: "SIGKILL",
    });
    const starts = (await readFile(join(root, "watch-starts"), "utf8"))
      .trim()
      .split("\n").length;
    return { ...result, starts };
  } finally {
    await stopFixturePrograms(root);
  }
}

const fast = (code: number): WatchExit => ({ code, milliseconds: 0 });

await test("CLV-298 the host starts the watch child again after it exits while the daemon runs, and logs the restart with the exit code", () =>
  withFiles({}, async (root) => {
    const result = await restartedHost(root, {
      exits: [fast(70)],
      lastStart: 2,
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "watch-restart code=70 delay=10ms\n");
    assert.equal(result.starts, 2);
    assert.equal(
      await readFile(join(root, "watch-stopped"), "utf8"),
      "stopped",
    );
  }));

await test("CLV-298 the host waits longer after each fast exit and stops the restarts after 5 restarts in 10 minutes", () =>
  withFiles({}, async (root) => {
    const result = await restartedHost(root, {
      exits: [fast(70), fast(70), fast(1), fast(70), fast(70), fast(70)],
      lastStart: 6,
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stderr,
      [
        "watch-restart code=70 delay=10ms",
        "watch-restart code=70 delay=20ms",
        "watch-restart code=1 delay=40ms",
        "watch-restart code=70 delay=80ms",
        "watch-restart code=70 delay=160ms",
        "watch-restart-stopped code=70 reason=restart-limit restarts=5 window=600000ms",
        "",
      ].join("\n"),
    );
    assert.equal(result.starts, 6);
  }));

await test("CLV-298 a watch child that ran longer than a fast exit restarts after the first delay again", () =>
  withFiles({}, async (root) => {
    const result = await restartedHost(root, {
      exits: [
        fast(70),
        fast(70),
        { code: 70, milliseconds: fastMilliseconds },
        fast(70),
      ],
      lastStart: 5,
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(
      result.stderr,
      [
        "watch-restart code=70 delay=10ms",
        "watch-restart code=70 delay=20ms",
        "watch-restart code=70 delay=10ms",
        "watch-restart code=70 delay=10ms",
        "",
      ].join("\n"),
    );
    assert.equal(result.starts, 5);
  }));

await test("CLV-298 restarts older than the window do not count toward the restart limit", () =>
  withFiles({}, async (root) => {
    const windowMilliseconds = testMilliseconds(3000);
    const result = await restartedHost(root, {
      exits: [
        fast(70),
        { code: 70, milliseconds: windowMilliseconds },
        fast(70),
        fast(70),
      ],
      lastStart: 4,
      policy: { ...policy, limit: 2, windowMilliseconds },
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(
      result.stderr,
      [
        "watch-restart code=70 delay=10ms",
        "watch-restart code=70 delay=10ms",
        "watch-restart code=70 delay=10ms",
        `watch-restart-stopped code=70 reason=restart-limit restarts=2 window=${String(windowMilliseconds)}ms`,
        "",
      ].join("\n"),
    );
    assert.equal(result.starts, 4);
  }));

await test("CLV-298 a stop of the daemon during the wait before a restart starts no watch child again", () =>
  withFiles({}, async (root) => {
    const started = performance.now();
    const result = await restartedHost(root, {
      exits: [fast(70)],
      lastStart: 1,
      policy: { ...policy, delayMilliseconds: 600_000 },
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.starts, 1);
    assert.ok(performance.now() - started < testMilliseconds(20_000));
  }));
