import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { restartMark, restartText } from "../src/restart-request.ts";
import { hostedPrograms } from "../tools/self-host-processes.ts";
import { programs } from "./self-host-processes-fixture.ts";
import { eventually } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

async function withChildren(
  options: {
    readonly stuckPrograms: readonly string[];
    readonly stopMilliseconds: number;
  },
  body: (scene: {
    readonly root: string;
    readonly directory: string;
    readonly hosting: Promise<number>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cloving-restart-children-"));
  try {
    const paths = await programs(root, {
      stuckPrograms: options.stuckPrograms,
      watchExits: [],
    });
    const directory = join(root, "host");
    await mkdir(directory, { recursive: true });
    const hosting = hostedPrograms({
      ...paths,
      repository: root,
      runtime: join(directory, "run"),
      directory,
      watchPort: "1",
      phoneRelay: "on",
      updateMilliseconds: undefined,
      restartMilliseconds: 50,
      stopMilliseconds: options.stopMilliseconds,
    });
    try {
      await eventually(() =>
        existsSync(join(root, "watch-1-ready")) &&
        existsSync(join(root, "relay-ready"))
          ? true
          : undefined,
      );
      await body({ root, directory, hosting });
    } finally {
      process.emit("SIGTERM");
      await hosting.catch(() => 1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function refusal(failure: string, signal: AbortSignal): Promise<string> {
  while (!signal.aborted) {
    if (existsSync(failure)) return readFile(failure, "utf8");
    await delay(50, undefined, { signal }).catch(() => undefined);
  }
  return "";
}

async function endedOrRefused(
  directory: string,
  hosting: Promise<number>,
): Promise<number | string> {
  const polling = new AbortController();
  try {
    return await Promise.race([
      hosting,
      refusal(join(directory, "restart-failure"), polling.signal),
    ]);
  } finally {
    polling.abort();
  }
}

function request(commandId: string): string {
  return restartText({
    at: "now",
    requestedAt: Date.now(),
    commandId,
    resumeQueue: false,
  });
}

function signalled(root: string, name: string): Promise<string> {
  return readFile(join(root, `${name}-signals`), "utf8").catch(() => "");
}

await test("CLV-320 CLV-337 a restart stops the watch and the relay before the daemon, stops the daemon with the signal that keeps turns, ends with exit 75, and a refused restart fails the test without a hang", () =>
  withChildren(
    { stuckPrograms: [], stopMilliseconds: testMilliseconds(10_000) },
    async ({ root, directory, hosting }) => {
      await writeFile(join(directory, "pending-restart-one"), request("plain"));
      assert.equal(await endedOrRefused(directory, hosting), 75);
      assert.equal(await signalled(root, "watch"), "SIGTERM\n");
      assert.equal(await signalled(root, "relay"), "SIGTERM\n");
      assert.equal(await signalled(root, "daemon"), "SIGUSR2\n");
      const starts = await readFile(join(root, "watch-starts"), "utf8");
      assert.equal(starts.trim().split("\n").length, 1);
      const daemonSignal = (await stat(join(root, "daemon-signals"))).mtimeMs;
      for (const name of ["watch", "relay"])
        assert.ok(
          (await stat(join(root, `${name}-stopped`))).mtimeMs <= daemonSignal,
          name,
        );
    },
  ));

await test("CLV-320 a child that ignores SIGTERM past the limit refuses the restart, and the daemon and the watch keep running", () =>
  withChildren(
    { stuckPrograms: ["relay"], stopMilliseconds: testMilliseconds(500) },
    async ({ root, directory, hosting }) => {
      const sent = request("stuck");
      await writeFile(join(directory, "pending-restart-one"), sent);
      const failure = join(directory, "restart-failure");
      await eventually(() => (existsSync(failure) ? true : undefined));
      const relay = await readFile(join(root, "relay-ready"), "utf8");
      assert.deepEqual(JSON.parse(await readFile(failure, "utf8")), {
        commandId: "stuck",
        requestedAt: restartMark(sent)?.requestedAt,
        code: "restart-children-alive",
        step: "stop",
        output: `${relay} relay`,
      });
      await eventually(() =>
        existsSync(join(directory, "claimed-restart")) ? undefined : true,
      );
      assert.equal(await signalled(root, "daemon"), "");
      await eventually(() =>
        existsSync(join(root, "watch-2-ready")) ? true : undefined,
      );
      process.emit("SIGTERM");
      assert.equal(await hosting, 0);
    },
  ));
