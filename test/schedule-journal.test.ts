import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { scheduleJournal } from "../src/daemon/schedule-journal.ts";
import { withFiles } from "./quality/files-fixture.ts";

const progress = { everySeconds: 300, nextAt: 600000, lastSlot: 1 };

await test("CLV-179 schedule state and pending submissions survive reopening", () =>
  withFiles({}, async (directory) => {
    const journal = await scheduleJournal(directory);
    assert.equal(journal.entries.size, 0);
    const saved = {
      ...progress,
      activeCommandId: "schedule:review:1",
      pending: { kind: "run" as const, input: { page: 2 } },
    };
    journal.entries.set("review", saved);
    await journal.save();
    assert.deepEqual(
      (await scheduleJournal(directory)).entries.get("review"),
      saved,
    );
    assert.equal(
      (await readFile(join(directory, "schedules.json"), "utf8")).endsWith(
        "\n",
      ),
      true,
    );
  }));

await test("CLV-179 corrupt schedule state fails closed without replacement", async () => {
  for (const value of [
    null,
    [],
    { review: null },
    { review: { ...progress, nextAt: -1 } },
    { review: { ...progress, lastSlot: 0.5 } },
    { review: { ...progress, everySeconds: 1 } },
    { review: { ...progress, pending: { kind: "skip", runId: "" } } },
    { review: { ...progress, activeCommandId: "" } },
    { review: { ...progress, pending: { kind: "run", input: null } } },
  ])
    await withFiles(
      { "schedules.json": JSON.stringify(value) },
      async (directory) => {
        const file = join(directory, "schedules.json");
        const before = await readFile(file, "utf8");
        await assert.rejects(
          scheduleJournal(directory),
          /invalid-schedule-state/,
        );
        assert.equal(await readFile(file, "utf8"), before);
      },
    );
});

await test("CLV-179 schedule journal propagates JSON and filesystem failures", () =>
  withFiles({ "schedules.json": "{" }, async (directory) => {
    await assert.rejects(scheduleJournal(directory), SyntaxError);
    await rm(join(directory, "schedules.json"));
    await mkdir(join(directory, "schedules.json"));
    await assert.rejects(scheduleJournal(directory), /EISDIR/);
    await rm(join(directory, "schedules.json"), { recursive: true });
    const journal = await scheduleJournal(directory);
    await mkdir(join(directory, "schedules.json.tmp"));
    await assert.rejects(journal.save(), /EISDIR/);
    await rm(join(directory, "schedules.json.tmp"), { recursive: true });
    await writeFile(join(directory, "schedules.json"), "{}");
    await journal.save();
  }));
