import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { refusedStart } from "./cli-start-fixture.ts";
import { ended, scene, withoutChildren } from "./self-host-fixture.ts";

await test("CLV-270 start reads the retention variables into daemon settings", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const child = await fixture.start({
      CLOVING_RETENTION_DAYS: "7",
      CLOVING_RETENTION_ACTION: "delete",
    });
    try {
      const launcher = await readFile(
        join(fixture.directory, "project/main.mjs"),
        "utf8",
      );
      assert.ok(
        launcher.includes(
          '\\"retention\\":{\\"days\\":7,\\"action\\":\\"delete\\",\\"archiveFolder\\":null}',
        ),
        launcher,
      );
    } finally {
      assert.equal(await ended(child), 0);
    }
  }));

await test("CLV-270 start refuses an invalid retention period and names the variable", async () => {
  assert.match(
    await refusedStart({
      CLOVING_RETENTION_DAYS: "0",
      CLOVING_SELF_UPDATE_SECONDS: undefined,
    }),
    /invalid-setting: CLOVING_RETENTION_DAYS/,
  );
});

await test("CLV-270 start opens the watch page after the daemon reports its start", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const child = await fixture.startUntil("Watch page: http://127.0.0.1:", {
      CLOVING_WATCH_PORT: "0",
    });
    assert.equal(await ended(child), 0);
  }));
