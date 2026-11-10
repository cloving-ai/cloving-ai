import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Fields, Reply } from "../src/protocol.ts";
import { listen } from "../src/service/transport.ts";
import { selfUpdateActive } from "../tools/self-update-host.ts";
import { selfUpdater } from "../tools/self-update.ts";
import { withUpdate } from "./self-update-fixture.ts";
import { withHarness } from "./service-fixture.ts";

function page(result: Fields): Reply {
  return { kind: "result", result };
}

async function withActivityReplies(
  replies: readonly Reply[],
  body: (scene: {
    readonly directory: string;
    readonly runtimeDirectory: string;
    readonly reads: Fields[];
  }) => Promise<void>,
): Promise<void> {
  await withHarness(async ({ stateDirectory: directory, runtimeDirectory }) => {
    const reads: Fields[] = [];
    const listener = await listen({
      path: join(runtimeDirectory, "control.sock"),
      handle: (request) => {
        assert.equal(request.operation, "status");
        reads.push(request.parameters);
        return Promise.resolve(replies[reads.length - 1]);
      },
    });
    try {
      await body({ directory, runtimeDirectory, reads });
    } finally {
      await listener.close();
    }
  });
}

for (const state of ["admitted", "running", "paused", "waiting", "unknown"]) {
  await test(`CLV-138 CLV-337 ${state} runs of any workflow do not hold an update, and the check reads no run list`, async () => {
    await withActivityReplies(
      [page({ runs: [{ workflowId: "another-workflow", state }], next: null })],
      async (scene) => {
        assert.equal(await selfUpdateActive(scene), false);
        assert.equal(scene.reads.length, 0);
      },
    );
  });
}

await test("CLV-138 CLV-337 a worker journal that the check cannot read fails closed", async () => {
  await withActivityReplies([], async (scene) => {
    await writeFile(join(scene.directory, "journal"), "not a folder");
    await withUpdate(async (fixture) => {
      const updater = selfUpdater({
        ...fixture.settings,
        active: () => selfUpdateActive(scene),
      });
      assert.equal(await updater.check(), undefined);
      assert.equal(fixture.actions.includes("stop"), false);
    });
  });
});
