import assert from "node:assert/strict";
import filesystem, { mkdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { selfUpdateActive } from "../tools/self-update-host.ts";
import { selfUpdater } from "../tools/self-update.ts";
import { withUpdate } from "./self-update-fixture.ts";

await test("CLV-138 the pending timestamp is published only after its write finishes", async () => {
  await withUpdate(async (fixture) => {
    fixture.worker.active = true;
    const writing = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const write = filesystem.writeFile;
    filesystem.writeFile = async (file, data) => {
      await write(file, "");
      writing.resolve(undefined);
      await release.promise;
      await write(file, data);
    };
    syncBuiltinESMExports();
    const checking = fixture.updater.check();
    try {
      await writing.promise;
      await assert.rejects(
        readFile(join(fixture.directory, "pending-self-update")),
        { code: "ENOENT" },
      );
    } finally {
      release.resolve(undefined);
      await checking;
      filesystem.writeFile = write;
      syncBuiltinESMExports();
    }
    assert.ok(
      Number(
        await readFile(join(fixture.directory, "pending-self-update"), "utf8"),
      ) > 0,
    );
  });
});

await test("CLV-138 a pending mark is removed when the checkout is already current", async () => {
  await withUpdate(async (fixture) => {
    fixture.worker.active = true;
    assert.equal(await fixture.updater.check(), undefined);
    const mark = join(fixture.directory, "pending-self-update");
    assert.ok(Number(await readFile(mark, "utf8")) > 0);
    fixture.replies["rev-parse refs/remotes/origin/main"] = "old\n";
    assert.equal(await fixture.updater.check(), undefined);
    await assert.rejects(readFile(mark), { code: "ENOENT" });
    assert.equal(fixture.actions.includes("stop"), false);
  });
});

await test("CLV-138 CLV-337 an open turn that cannot keep running holds the update, and an active run does not", async () => {
  await withUpdate(async (fixture) => {
    const turn = join(fixture.directory, "journal", "turn");
    await mkdir(turn, { recursive: true });
    await writeFile(join(turn, "started.json"), "{}");
    const updater = selfUpdater({
      ...fixture.settings,
      active: () =>
        selfUpdateActive({
          directory: fixture.directory,
          runtimeDirectory: join(fixture.directory, "run"),
        }),
    });
    const before = Date.now();
    assert.equal(await updater.check(), undefined);
    assert.equal(fixture.actions.includes("stop"), false);
    const mark = join(fixture.directory, "pending-self-update");
    const timestamp = Number(await readFile(mark, "utf8"));
    assert.ok(timestamp >= before && timestamp <= Date.now());
    assert.equal(await updater.check(), undefined);
    assert.equal(Number(await readFile(mark, "utf8")), timestamp);
    await writeFile(join(turn, "result.json"), "{}");
    assert.equal(await updater.check(), 75);
    await assert.rejects(readFile(mark), { code: "ENOENT" });
  });
});
