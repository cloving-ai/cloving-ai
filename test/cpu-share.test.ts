import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cpuShare } from "../src/queue-room.ts";
import { turnStartEnvironment } from "../src/daemon/turn-variables.ts";
import { markedCalls } from "../src/daemon/working-runs.ts";

await test("CLV-309 the share of the cores is the cores divided by the working runs, at least 1", () => {
  assert.equal(cpuShare(12, 3), 4);
  assert.equal(cpuShare(12, 5), 2);
  assert.equal(cpuShare(4, 6), 1);
  assert.equal(cpuShare(12, 0), 12);
});

await test("CLV-309 each turn gets CLOVING_CPU_SHARE from the working runs and its attachments folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpu-share-"));
  try {
    const opened = async (folder: string, runId: string) => {
      await mkdir(join(root, folder, runId), { recursive: true });
      await writeFile(
        join(root, folder, runId, "started.json"),
        JSON.stringify({ runId }),
      );
    };
    await opened("journal", "first");
    await opened("journal", "second");
    await opened("commands", "second");
    const start = {
      intent: { target: "repository:main", runId: "third" },
      profile: { env: { PROFILE: "on" } },
    };
    const settings = { worktrees: join(root, "worktrees") };
    const shared = await turnStartEnvironment(settings, {
      ...start,
      cores: 12,
    });
    assert.equal(shared["CLOVING_CPU_SHARE"], "4");
    assert.equal(shared["PROFILE"], "on");
    assert.match(
      String(shared["CLOVING_ATTACHMENTS_DIRECTORY"]),
      /attachments/,
    );
    const own = await turnStartEnvironment(settings, {
      ...start,
      intent: { ...start.intent, runId: "first" },
      cores: 12,
    });
    assert.equal(own["CLOVING_CPU_SHARE"], "6");
    const host = await turnStartEnvironment(settings, start);
    assert.equal(
      host["CLOVING_CPU_SHARE"],
      String(cpuShare(availableParallelism(), 3)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("CLV-309 a run in a local merge check takes a share of the cores, a run that waits for CI does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpu-share-"));
  try {
    for (const runId of ["check", "ci"]) {
      await mkdir(join(root, "github", runId), { recursive: true });
      await writeFile(
        join(root, "github", runId, "started.json"),
        JSON.stringify({ runId }),
      );
    }
    const release = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<undefined>();
    const checked = markedCalls(
      {
        gh: () => Promise.resolve(""),
        git: () => Promise.resolve(""),
        run: () => {
          entered.resolve(undefined);
          return release.promise;
        },
      },
      join(root, "github", "check"),
    ).run(["check"], root);
    await entered.promise;
    const environment = await turnStartEnvironment(
      { worktrees: join(root, "worktrees") },
      {
        intent: { target: "repository:main", runId: "turn" },
        profile: {},
        cores: 12,
      },
    );
    release.resolve("passed");
    await checked;
    assert.equal(environment["CLOVING_CPU_SHARE"], "6");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
