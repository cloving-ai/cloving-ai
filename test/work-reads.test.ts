import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { daemonWorkReads } from "../src/daemon/work-reads.ts";
import type { Reply } from "../src/protocol.ts";
import { listen } from "../src/service/transport.ts";
import { atGap, workInProgress } from "../src/work-gap.ts";
import { withHarness } from "./service-fixture.ts";

async function withService(
  reply: Reply,
  body: (places: {
    readonly directory: string;
    readonly runtimeDirectory: string;
  }) => Promise<void>,
): Promise<void> {
  await withHarness(async ({ stateDirectory, runtimeDirectory }) => {
    const listener = await listen({
      path: join(runtimeDirectory, "control.sock"),
      handle: () => Promise.resolve(reply),
    });
    try {
      await body({ directory: stateDirectory, runtimeDirectory });
    } finally {
      await listener.close();
    }
  });
}

const quiet: Reply = { kind: "result", result: { runs: [], next: null } };

await test("CLV-306 the daemon reads an open turn only from a started turn folder with no result", () =>
  withService(quiet, async (places) => {
    const reads = daemonWorkReads(places);
    assert.equal(atGap(await workInProgress(reads)), true);
    const journal = join(places.directory, "journal");
    await mkdir(join(journal, "unstarted"), { recursive: true });
    await mkdir(join(journal, "finished"));
    await writeFile(join(journal, "finished", "started.json"), "{}");
    await writeFile(join(journal, "finished", "result.json"), "{}");
    await writeFile(join(journal, "note.json"), "{}");
    assert.equal(await reads.openTurn(), false);
    await mkdir(join(journal, "open"));
    await writeFile(join(journal, "open", "started.json"), "{}");
    assert.equal(await reads.openTurn(), true);
    assert.equal(await reads.pendingSubmission(), false);
    await writeFile(join(places.directory, "queue-submission"), "");
    assert.deepEqual(await workInProgress(reads), {
      activeRuns: 0,
      runIds: [],
      openTurn: true,
      pendingSubmission: true,
    });
  }));

await test("CLV-306 the daemon work reads fail on a refused status and on a folder it cannot read", () =>
  withService(
    { kind: "error", error: { code: "authority-unavailable", detail: "down" } },
    async (places) => {
      await assert.rejects(
        daemonWorkReads(places).runPage(""),
        new Error("authority-unavailable"),
      );
      const file = join(places.directory, "not-a-folder");
      await writeFile(file, "");
      const broken = daemonWorkReads({ ...places, directory: file });
      await assert.rejects(broken.openTurn(), { code: "ENOTDIR" });
      await assert.rejects(broken.pendingSubmission(), { code: "ENOTDIR" });
    },
  ));
