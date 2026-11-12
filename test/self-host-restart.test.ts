import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import filesystem, {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mock, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { restartMarks } from "../src/daemon/restart-marks.ts";
import {
  claimHost,
  claimText,
  restartMark,
  restartText,
  type RestartMark,
  type RestartTime,
} from "../src/restart-request.ts";
import { hostedPrograms } from "../tools/self-host-processes.ts";
import {
  claimedRestart,
  clearedRestart,
  productCommit,
} from "../tools/self-host-restart.ts";
import { programs } from "./self-host-processes-fixture.ts";
import { eventually } from "./service-fixture.ts";

async function withHost(
  options: {
    readonly daemonMilliseconds?: number;
    readonly readyPrograms?: readonly string[];
  },
  body: (scene: {
    readonly root: string;
    readonly directory: string;
    readonly hosted: () => Promise<number>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cloving-restart-host-"));
  try {
    const paths = await programs(root, options);
    const directory = join(root, "host");
    await mkdir(directory, { recursive: true });
    await body({
      root,
      directory,
      hosted: () =>
        hostedPrograms({
          ...paths,
          repository: root,
          runtime: join(directory, "run"),
          directory,
          watchPort: "off",
          phoneRelay: "off",
          updateMilliseconds: undefined,
          restartMilliseconds: 50,
        }),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function mark(
  at: RestartTime,
  options: Pick<RestartMark, "settings" | "variables"> & {
    readonly resumeQueue?: true;
  } = {},
): string {
  return restartText({
    at,
    requestedAt: Date.now(),
    commandId: `restart-${at}`,
    ...options,
    resumeQueue: options.resumeQueue ?? false,
  });
}

async function openTurn(directory: string): Promise<string> {
  const turn = join(directory, "journal", "turn");
  await mkdir(turn, { recursive: true });
  await writeFile(join(turn, "started.json"), "{}");
  return turn;
}

await test("CLV-306 CLV-337 a restart at the next gap waits for the open turn and then stops the programs with exit 75, and the daemon gets the signal that keeps turns", () =>
  withHost({}, async ({ root, directory, hosted }) => {
    const turn = await openTurn(directory);
    const hosting = hosted();
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    await writeFile(join(directory, "pending-restart-one"), mark("gap"));
    await delay(400);
    assert.equal(existsSync(join(root, "daemon-signals")), false);
    await writeFile(join(turn, "result.json"), "{}");
    assert.equal(await hosting, 75);
    assert.equal(existsSync(join(directory, "resume-queue")), false);
    assert.equal(existsSync(join(directory, "restart-settings")), false);
    assert.equal(existsSync(join(directory, "restart-variables")), false);
    assert.equal(
      await readFile(join(root, "daemon-signals"), "utf8"),
      "SIGUSR2\n",
    );
    assert.equal(existsSync(join(directory, "pending-restart-one")), false);
  }));

await test("CLV-306 CLV-337 CLV-352 a restart now stops the programs at once while a turn is open, the daemon gets the signal that keeps turns, and the host leaves the notes of the request", () =>
  withHost({}, async ({ root, directory, hosted }) => {
    await openTurn(directory);
    const hosting = hosted();
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    await writeFile(
      join(directory, "pending-restart-one"),
      mark("now", {
        resumeQueue: true,
        settings: "files",
        variables: { CLOVING_QUEUE_LANES: "8" },
      }),
    );
    assert.equal(await hosting, 75);
    assert.equal(existsSync(join(directory, "resume-queue")), true);
    assert.equal(
      await readFile(join(directory, "restart-settings"), "utf8"),
      "files",
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "restart-variables"), "utf8")),
      { CLOVING_QUEUE_LANES: "8" },
    );
    assert.equal(
      await readFile(join(root, "daemon-signals"), "utf8"),
      "SIGUSR2\n",
    );
    assert.equal(existsSync(join(directory, "pending-restart-one")), false);
  }));

await test("CLV-306 a mark that the host cannot read and a failed gap check keep the programs running", () =>
  withHost({}, async ({ root, directory, hosted }) => {
    const hosting = hosted();
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    const place = join(directory, "pending-restart-one");
    await mkdir(place);
    await delay(300);
    assert.equal(existsSync(join(root, "daemon-signals")), false);
    await rm(place, { recursive: true });
    await writeFile(join(directory, "journal"), "not a folder");
    await writeFile(place, mark("gap"));
    await delay(300);
    assert.equal(existsSync(join(root, "daemon-signals")), false);
    await rm(join(directory, "journal"));
    assert.equal(await hosting, 75);
  }));

await test("CLV-306 a start removes a restart mark that an earlier start left", () =>
  withHost(
    { daemonMilliseconds: 300, readyPrograms: [] },
    async ({ directory, hosted }) => {
      await writeFile(join(directory, "pending-restart-one"), mark("now"));
      await writeFile(join(directory, "claimed-restart"), mark("gap"));
      assert.equal(await hosted(), 0);
      assert.equal(existsSync(join(directory, "pending-restart-one")), false);
      assert.equal(existsSync(join(directory, "claimed-restart")), false);
    },
  ));

async function markAt(path: string): Promise<RestartMark | undefined> {
  return restartMark(await readFile(path, "utf8"));
}

async function requestName(directory: string): Promise<string> {
  const names = (await readdir(directory)).filter((name) =>
    name.startsWith("pending-restart-"),
  );
  assert.equal(names.length, 1, names.join(" "));
  return String(names[0]);
}

await test("CLV-306 the host claims only the request file that it checked, names its process in the claim, and a cancel stops the claim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloving-claim-"));
  try {
    const marks = restartMarks(directory);
    const claimed = join(directory, "claimed-restart");
    const checked = restartMark(mark("gap"));
    assert.ok(checked);
    await marks.request(checked);
    const request = { name: await requestName(directory), mark: checked };
    assert.deepEqual(await claimedRestart(directory, request), checked);
    assert.deepEqual(await markAt(claimed), checked);
    assert.equal(claimHost(await readFile(claimed, "utf8")), process.pid);
    assert.deepEqual(await marks.pending(), checked);
    assert.equal(await marks.cancel(), "started");
    await rm(claimed);
    assert.equal(await claimedRestart(directory, request), undefined);
    const later = { ...checked, commandId: "restart-later" };
    await marks.request(later);
    const cancelled = { name: await requestName(directory), mark: later };
    assert.equal(await marks.cancel(), "cancelled");
    assert.equal(await claimedRestart(directory, cancelled), undefined);
    assert.equal(existsSync(claimed), false);
    await clearedRestart(join(directory, "missing"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("CLV-306 a host claim of a request that the daemon replaced changes nothing in the folder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloving-claim-"));
  try {
    const marks = restartMarks(directory);
    const checked = restartMark(mark("gap"));
    assert.ok(checked);
    await marks.request(checked);
    const stale = { name: await requestName(directory), mark: checked };
    const newer = { ...checked, commandId: "restart-newer", resumeQueue: true };
    await marks.request(newer);
    const past = new Date(1_700_000_000_000);
    await utimes(directory, past, past);
    assert.equal(await claimedRestart(directory, stale), undefined);
    assert.equal((await stat(directory)).mtimeMs, past.getTime());
    assert.deepEqual(await marks.pending(), newer);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("CLV-320 a claim that the host cannot write puts the request back with no other file, so a cancel still stops it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloving-claim-"));
  const write = filesystem.writeFile;
  try {
    const marks = restartMarks(directory);
    const checked = restartMark(mark("gap"));
    assert.ok(checked);
    await marks.request(checked);
    const name = await requestName(directory);
    const text = await readFile(join(directory, name), "utf8");
    mock.method(
      filesystem,
      "writeFile",
      async (file: Parameters<typeof write>[0]) => {
        await write(file, "");
        throw Object.assign(new Error("no space left on device"), {
          code: "ENOSPC",
        });
      },
    );
    syncBuiltinESMExports();
    await assert.rejects(claimedRestart(directory, { name, mark: checked }), {
      code: "ENOSPC",
    });
    mock.restoreAll();
    syncBuiltinESMExports();
    assert.deepEqual(await readdir(directory), [name]);
    assert.equal(await readFile(join(directory, name), "utf8"), text);
    assert.deepEqual(await marks.pending(), checked);
    assert.equal(await marks.cancel(), "cancelled");
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("CLV-306 the product commit is null outside the top folder of a git checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloving-commit-"));
  try {
    assert.equal(await productCommit(root), null);
    assert.equal(await productCommit(resolve("src")), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("CLV-320 a claim names its start program only with a whole positive process ID", () => {
  const checked = restartMark(mark("gap"));
  assert.ok(checked);
  assert.equal(claimHost(claimText(checked, 4321)), 4321);
  assert.deepEqual(restartMark(claimText(checked, 4321)), checked);
  for (const hostProcessId of [0, -1, 1.5, "4321", null])
    assert.equal(claimHost(JSON.stringify({ hostProcessId })), undefined);
  assert.equal(claimHost("not json"), undefined);
});
