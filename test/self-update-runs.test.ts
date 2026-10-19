import assert from "node:assert/strict";
import filesystem, { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { listen } from "../src/service/transport.ts";
import { selfUpdateActive } from "../tools/self-update-host.ts";
import { selfUpdater } from "../tools/self-update.ts";
import { withUpdate } from "./self-update-fixture.ts";
import { withHarness } from "./service-fixture.ts";

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

await test("CLV-138 an active run between turns holds the update until all workflows are terminal", async () => {
  await withHarness(async ({ runtimeDirectory }) => {
    await withUpdate(async (fixture) => {
      let state = "running";
      const listener = await listen({
        path: join(runtimeDirectory, "control.sock"),
        handle: (request) => {
          assert.equal(request.operation, "status");
          return Promise.resolve({
            kind: "result",
            result: {
              runs: [
                { workflowId: "develop-issue", state: "completed" },
                { workflowId: "analyze-chats", state },
                { workflowId: "develop-prd", state: "cancelled" },
                { workflowId: "develop-ticket", state: "failed" },
              ],
              next: null,
            },
          });
        },
      });
      const updater = selfUpdater({
        ...fixture.settings,
        active: () =>
          selfUpdateActive({ directory: fixture.directory, runtimeDirectory }),
      });
      try {
        const before = Date.now();
        assert.equal(await updater.check(), undefined);
        assert.equal(fixture.actions.includes("stop"), false);
        const mark = join(fixture.directory, "pending-self-update");
        const timestamp = Number(await readFile(mark, "utf8"));
        assert.ok(timestamp >= before && timestamp <= Date.now());
        assert.equal(await updater.check(), undefined);
        assert.equal(Number(await readFile(mark, "utf8")), timestamp);
        state = "completed";
        assert.equal(await updater.check(), 75);
        await assert.rejects(readFile(mark), { code: "ENOENT" });
      } finally {
        await listener.close();
      }
    });
  });
});
