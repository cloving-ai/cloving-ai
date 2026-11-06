import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  restartMark,
  restartText,
  serialCalls,
} from "../src/restart-request.ts";
import {
  checkoutLock,
  restartWatch,
  type CheckoutLock,
} from "../tools/self-host-restart.ts";
import {
  fakeNpm,
  npmPath,
  updateMark,
  withUpdateHost,
} from "./restart-host-fixture.ts";
import { withUpdateRepository } from "./self-update-git-fixture.ts";
import { eventually } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

afterEach(() => {
  mock.restoreAll();
});

await test("CLV-320 a restart with an update stops the programs at the gap, then builds the new commit and ends with exit 75", () =>
  withUpdateHost(async ({ root, directory, git, target, hosted }) => {
    const hosting = hosted();
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    await writeFile(
      join(directory, "pending-restart-one"),
      updateMark("gap", "restart-update"),
    );
    assert.equal(await hosting, 75);
    assert.equal(git(["rev-parse", "HEAD"]), target);
    assert.equal(
      await readFile(join(root, "npm-calls"), "utf8"),
      "run build\n",
    );
    assert.equal(
      await readFile(join(root, "daemon-signals"), "utf8"),
      "SIGTERM\n",
    );
    assert.equal(await readFile(join(root, "npm-daemon"), "utf8"), "stopped\n");
  }));

await test("CLV-320 a failed build of an update puts the checkout back on the old commit, restarts with exit 75 and keeps the step for the command", () =>
  withUpdateHost(async ({ root, directory, git, old, hosted }) => {
    await writeFile(join(root, "build-fails"), "");
    const hosting = hosted();
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    const request = updateMark("now", "restart-broken");
    await writeFile(join(directory, "pending-restart-one"), request);
    assert.equal(await hosting, 75);
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "restart-failure"), "utf8")),
      {
        commandId: "restart-broken",
        requestedAt: restartMark(request)?.requestedAt,
        code: "restart-update-failed",
        step: "build",
        output:
          "> tsc --project tsconfig.build.json\nerror TS2322: Type 'string' is not assignable",
      },
    );
    assert.equal(existsSync(join(directory, "claimed-restart")), false);
    assert.equal(git(["rev-parse", "HEAD"]), old);
    assert.equal(
      await readFile(join(root, "npm-calls"), "utf8"),
      "run build\nrun build\n",
    );
    assert.equal(
      await readFile(join(root, "npm-daemon"), "utf8"),
      "stopped\nstopped\n",
    );
  }));

await test("CLV-320 local changes skip the update, keep the note for the command and restart on the current commit", () =>
  withUpdateHost(async ({ root, directory, git, old, hosted }) => {
    const hosting = hosted();
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    await writeFile(
      join(git(["rev-parse", "--show-toplevel"]), "notes.txt"),
      "local\n",
    );
    const request = updateMark("gap", "restart-dirty");
    await writeFile(join(directory, "pending-restart-one"), request);
    assert.equal(await hosting, 75);
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "restart-failure"), "utf8")),
      {
        commandId: "restart-dirty",
        requestedAt: restartMark(request)?.requestedAt,
        code: "restart-update-skipped",
        step: "clean",
        output: "?? notes.txt",
      },
    );
    assert.equal(git(["rev-parse", "HEAD"]), old);
    assert.equal(existsSync(join(root, "npm-calls")), false);
  }));

await test("CLV-306 a stop during the build of an update ends the host at once on the old commit with no restart", () =>
  withUpdateHost(async ({ root, directory, git, old, hosted }) => {
    await writeFile(join(root, "build-blocks"), "");
    const hosting = hosted();
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    await writeFile(
      join(directory, "pending-restart-one"),
      updateMark("now", "restart-stopped"),
    );
    await eventually(() =>
      existsSync(join(root, "building")) ? true : undefined,
    );
    const errors: string[] = [];
    mock.method(process.stderr, "write", (line: string | Uint8Array) => {
      errors.push(String(line));
      return true;
    });
    process.emit("SIGTERM");
    assert.equal(
      await Promise.race([hosting, delay(testMilliseconds(5000), "running")]),
      0,
    );
    assert.equal(git(["rev-parse", "HEAD"]), old);
    assert.equal(
      await readFile(join(root, "npm-calls"), "utf8"),
      "run build\n",
    );
    assert.match(
      errors.join(""),
      /Restart update failed at step build\.\n[^]*The service stopped during the update\. The checkout is back on [0-9a-f]{40}\. Run npm run build in the checkout before the next start\./,
    );
  }));

async function checkoutWatch(scene: {
  readonly root: string;
  readonly repository: string;
  readonly stopping: AbortController;
  readonly stop: () => Promise<void>;
  readonly exclusive: CheckoutLock;
}): Promise<{ readonly watching: Promise<number | undefined> }> {
  const bin = await fakeNpm(scene.root);
  const directory = join(scene.root, "host");
  await mkdir(directory, { recursive: true });
  const watching = restartWatch({
    directory,
    runtime: join(directory, "run"),
    checkout: scene.repository,
    environment: npmPath(bin),
    milliseconds: 50,
    stopChildren: () => Promise.resolve([]),
    stopping: scene.stopping.signal,
    stop: scene.stop,
    exclusive: scene.exclusive,
  });
  return { watching };
}

async function withHeldCheckout(
  body: (scene: {
    readonly root: string;
    readonly git: (argumentsList: readonly string[]) => string;
    readonly old: string;
    readonly target: string;
    readonly stopping: AbortController;
    readonly stops: string[];
    readonly gate: PromiseWithResolvers<undefined>;
    readonly watching: Promise<number | undefined>;
  }) => Promise<void>,
): Promise<void> {
  await withUpdateRepository(async ({ root, repository, git, old, target }) => {
    const exclusive = serialCalls();
    const gate = Promise.withResolvers<undefined>();
    const holding = exclusive(() => gate.promise);
    const stopping = new AbortController();
    const stops: string[] = [];
    const { watching } = await checkoutWatch({
      root,
      repository,
      stopping,
      stop: () => {
        stops.push("stop");
        return Promise.resolve();
      },
      exclusive,
    });
    const directory = join(root, "host");
    await writeFile(
      join(directory, "pending-restart-one"),
      updateMark("now", "restart-held"),
    );
    await eventually(() =>
      existsSync(join(directory, "claimed-restart")) ? true : undefined,
    );
    try {
      await body({
        root,
        git,
        old,
        target,
        stopping,
        stops,
        gate,
        watching,
      });
    } finally {
      gate.resolve(undefined);
      stopping.abort();
      await Promise.allSettled([holding, watching]);
    }
  });
}

await test("CLV-306 a restart update waits while another update holds the checkout", () =>
  withHeldCheckout(
    async ({ root, git, old, target, stops, gate, watching }) => {
      assert.equal(
        await Promise.race([
          watching,
          delay(testMilliseconds(2000), "waiting"),
        ]),
        "waiting",
      );
      assert.equal(git(["rev-parse", "HEAD"]), old);
      assert.equal(existsSync(join(root, "npm-calls")), false);
      gate.resolve(undefined);
      assert.equal(await watching, 75);
      assert.equal(git(["rev-parse", "HEAD"]), target);
      assert.deepEqual(stops, ["stop"]);
    },
  ));

await test("CLV-306 a restart that waits for the checkout does nothing after the other update stops the host", () =>
  withHeldCheckout(
    async ({ root, git, old, stopping, stops, gate, watching }) => {
      stopping.abort();
      gate.resolve(undefined);
      assert.equal(await watching, undefined);
      assert.equal(git(["rev-parse", "HEAD"]), old);
      assert.equal(existsSync(join(root, "npm-calls")), false);
      assert.equal(existsSync(join(root, "host", "restart-failure")), false);
      assert.deepEqual(stops, []);
    },
  ));

await test("CLV-320 a stop signal while a restart stops the programs ends the watch with no update and no restart", () =>
  withUpdateRepository(async ({ root, repository, git, old }) => {
    const stopping = new AbortController();
    const { watching } = await checkoutWatch({
      root,
      repository,
      stopping,
      stop: () => {
        stopping.abort();
        return Promise.resolve();
      },
      exclusive: checkoutLock(new AbortController()),
    });
    const directory = join(root, "host");
    await writeFile(
      join(directory, "pending-restart-one"),
      restartText({
        at: "now",
        requestedAt: Date.now(),
        commandId: "restart-signal",
        resumeQueue: true,
        settings: "files",
        update: true,
      }),
    );
    assert.equal(await watching, undefined);
    assert.equal(git(["rev-parse", "HEAD"]), old);
    assert.equal(existsSync(join(directory, "resume-queue")), false);
    assert.equal(existsSync(join(directory, "restart-settings")), false);
  }));

await test("CLV-306 a checkout lock holder that ends with a status stops the watches before the next holder starts", async () => {
  const stopping = new AbortController();
  const exclusive = checkoutLock(stopping);
  const seen: boolean[] = [];
  const turn = (status: number | undefined) => () => {
    seen.push(stopping.signal.aborted);
    return Promise.resolve(status);
  };
  assert.deepEqual(
    await Promise.all([
      exclusive(turn(undefined)),
      exclusive(turn(75)),
      exclusive(turn(undefined)),
    ]),
    [undefined, 75, undefined],
  );
  assert.deepEqual(seen, [false, false, true]);
});

await test("CLV-306 the self-update checks nothing while a restart update builds", () =>
  withUpdateHost(
    async ({ root, directory, git, target, hosted }) => {
      await writeFile(join(root, "build-blocks"), "");
      const turn = join(directory, "journal", "turn");
      await mkdir(turn, { recursive: true });
      await writeFile(join(turn, "started.json"), "{}");
      const hosting = hosted();
      await eventually(() =>
        existsSync(join(directory, "pending-self-update")) ? true : undefined,
      );
      await writeFile(
        join(directory, "pending-restart-one"),
        updateMark("now", "restart-alone"),
      );
      await eventually(() =>
        existsSync(join(root, "building")) ? true : undefined,
      );
      const fetched = join(
        git(["rev-parse", "--absolute-git-dir"]),
        "FETCH_HEAD",
      );
      const before = (await stat(fetched)).mtimeMs;
      await delay(testMilliseconds(1500));
      assert.equal((await stat(fetched)).mtimeMs, before);
      await writeFile(join(root, "build-release"), "");
      assert.equal(await hosting, 75);
      assert.equal(git(["rev-parse", "HEAD"]), target);
    },
    { updateMilliseconds: 50 },
  ));
