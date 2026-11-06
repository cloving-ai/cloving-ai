import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { restartText, type RestartTime } from "../src/restart-request.ts";
import { hostedPrograms } from "../tools/self-host-processes.ts";
import { productCommit } from "../tools/self-host-restart.ts";
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
  options: { readonly resumeQueue?: true } = {},
): string {
  return restartText({
    at,
    requestedAt: Date.now(),
    commandId: `restart-${at}`,
    resumeQueue: options.resumeQueue ?? false,
  });
}

async function openTurn(directory: string): Promise<string> {
  const turn = join(directory, "journal", "turn");
  await mkdir(turn, { recursive: true });
  await writeFile(join(turn, "started.json"), "{}");
  return turn;
}

await test("CLV-306 a restart at the next gap waits for the open turn and then stops the programs with exit 75", () =>
  withHost({}, async ({ root, directory, hosted }) => {
    const turn = await openTurn(directory);
    const hosting = hosted();
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    await writeFile(join(directory, "pending-restart"), mark("gap"));
    await delay(400);
    assert.equal(existsSync(join(root, "daemon-signals")), false);
    await writeFile(join(turn, "result.json"), "{}");
    assert.equal(await hosting, 75);
    assert.equal(existsSync(join(directory, "resume-queue")), false);
    assert.equal(
      await readFile(join(root, "daemon-signals"), "utf8"),
      "SIGTERM\n",
    );
    assert.equal(existsSync(join(directory, "pending-restart")), false);
  }));

await test("CLV-306 a restart now stops the programs at once while a turn is open", () =>
  withHost({}, async ({ root, directory, hosted }) => {
    await openTurn(directory);
    const hosting = hosted();
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    await writeFile(
      join(directory, "pending-restart"),
      mark("now", { resumeQueue: true }),
    );
    assert.equal(await hosting, 75);
    assert.equal(existsSync(join(directory, "resume-queue")), true);
    assert.equal(
      await readFile(join(root, "daemon-signals"), "utf8"),
      "SIGTERM\n",
    );
    assert.equal(existsSync(join(directory, "pending-restart")), false);
  }));

await test("CLV-306 a mark that the host cannot read and a failed gap check keep the programs running", () =>
  withHost({}, async ({ root, directory, hosted }) => {
    const hosting = hosted();
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    const place = join(directory, "pending-restart");
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
      await writeFile(join(directory, "pending-restart"), mark("now"));
      assert.equal(await hosted(), 0);
      assert.equal(existsSync(join(directory, "pending-restart")), false);
    },
  ));

await test("CLV-306 the product commit is null outside the top folder of a git checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloving-commit-"));
  try {
    assert.equal(await productCommit(root), null);
    assert.equal(await productCommit(resolve("src")), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
