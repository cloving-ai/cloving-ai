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
import { restartMark, restartText } from "../src/restart-request.ts";
import { hostedPrograms } from "../tools/self-host-processes.ts";
import { programs } from "./self-host-processes-fixture.ts";
import { eventually } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

async function withChildren(
  options: { readonly stuckPrograms: readonly string[] },
  body: (scene: {
    readonly root: string;
    readonly directory: string;
    readonly hosting: Promise<number>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cloving-restart-children-"));
  try {
    const paths = await programs(root, { ...options, watchExits: [] });
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
      stopMilliseconds: testMilliseconds(500),
    });
    await eventually(() =>
      existsSync(join(root, "watch-1-ready")) &&
      existsSync(join(root, "relay-ready"))
        ? true
        : undefined,
    );
    await body({ root, directory, hosting });
  } finally {
    await rm(root, { recursive: true, force: true });
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

await test("CLV-320 a restart stops the watch and the relay before the daemon and ends with exit 75", () =>
  withChildren({ stuckPrograms: [] }, async ({ root, directory, hosting }) => {
    await writeFile(join(directory, "pending-restart-one"), request("plain"));
    assert.equal(await hosting, 75);
    assert.equal(await signalled(root, "watch"), "SIGTERM\n");
    assert.equal(await signalled(root, "relay"), "SIGTERM\n");
    assert.equal(await signalled(root, "daemon"), "SIGTERM\n");
    const starts = await readFile(join(root, "watch-starts"), "utf8");
    assert.equal(starts.trim().split("\n").length, 1);
    const daemonSignal = (await stat(join(root, "daemon-signals"))).mtimeMs;
    for (const name of ["watch", "relay"])
      assert.ok(
        (await stat(join(root, `${name}-stopped`))).mtimeMs <= daemonSignal,
        name,
      );
  }));

await test("CLV-320 a child that ignores SIGTERM past the limit refuses the restart, and the daemon and the watch keep running", () =>
  withChildren(
    { stuckPrograms: ["relay"] },
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
      assert.equal(existsSync(join(directory, "claimed-restart")), false);
      assert.equal(await signalled(root, "daemon"), "");
      await eventually(() =>
        existsSync(join(root, "watch-2-ready")) ? true : undefined,
      );
      process.emit("SIGTERM");
      assert.equal(await hosting, 0);
    },
  ));
