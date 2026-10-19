import assert from "node:assert/strict";
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
  await test(`CLV-138 ${state} runs of any workflow prevent an update`, async () => {
    await withActivityReplies(
      [page({ runs: [{ workflowId: "another-workflow", state }], next: null })],
      async (scene) => {
        assert.equal(await selfUpdateActive(scene), true);
        assert.equal(scene.reads.length, 1);
      },
    );
  });
}

await test("CLV-138 the activity check follows terminal pages to find a paused run", async () => {
  await withActivityReplies(
    [
      page({
        runs: [
          { state: "completed" },
          { state: "failed" },
          { state: "cancelled" },
        ],
        next: "first",
      }),
      page({
        runs: [{ workflowId: "develop-prd", state: "paused" }],
        next: null,
      }),
    ],
    async (scene) => {
      assert.equal(await selfUpdateActive(scene), true);
      assert.deepEqual(scene.reads, [
        { limit: 500 },
        { limit: 500, after: "first" },
      ]);
    },
  );
});

for (const reply of [
  {
    kind: "error",
    error: { code: "authority-unavailable", detail: "Unavailable." },
  },
  page({ runs: "invalid", next: null }),
  page({ runs: [null], next: null }),
  page({ runs: [], next: "" }),
  page({ runs: [], next: 1 }),
  page({ runs: [] }),
] satisfies readonly Reply[]) {
  await test(`CLV-138 unavailable or malformed status fails closed: ${JSON.stringify(reply)}`, async () => {
    await withActivityReplies([reply], async (scene) => {
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
}
