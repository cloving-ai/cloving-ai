import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { selfUpdater } from "../tools/self-update.ts";
import {
  lockCommand,
  mergeCommand,
  statusCommand,
  withUpdate,
} from "./self-update-fixture.ts";

for (const rejected of [
  "lock",
  "failed-target",
  "dirty",
  "branch",
  "fetch",
  "merge",
  "stop",
]) {
  await test(`CLV-138 abandoning an update clears its queue hold: ${rejected}`, async () => {
    await withUpdate(async (fixture) => {
      fixture.worker.active = true;
      await fixture.updater.check();
      const mark = join(fixture.directory, "pending-self-update");
      assert.ok(Number(await readFile(mark, "utf8")) > 0);
      fixture.worker.active = false;
      if (rejected === "lock")
        fixture.failures.set(lockCommand, new Error("lock changed"));
      if (rejected === "failed-target")
        await writeFile(
          join(fixture.directory, "failed-self-updates"),
          "target\n",
        );
      if (rejected === "dirty")
        fixture.replies[statusCommand] = " M changed.ts\n";
      if (rejected === "branch")
        fixture.replies["symbolic-ref HEAD"] = "refs/heads/work\n";
      if (rejected === "fetch")
        fixture.failures.set("fetch origin", new Error("offline"));
      if (rejected === "merge")
        fixture.failures.set(mergeCommand, new Error("refused"));
      const updater =
        rejected === "stop"
          ? selfUpdater({
              ...fixture.settings,
              stop: () => Promise.reject(new Error("stopped")),
            })
          : fixture.updater;
      await updater.check().catch(() => undefined);
      await assert.rejects(readFile(mark), { code: "ENOENT" });
    });
  });
}
