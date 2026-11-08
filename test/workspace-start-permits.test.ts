import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { workspacePermits, type Permit } from "../src/cli/workspace-permit.ts";
import type { WorkspaceHost } from "../src/cli/workspace-start.ts";
import { listen } from "../src/service/transport.ts";
import { alpha, pair, root, started } from "./workspace-start-harness.ts";

const permits = join(root, "state/cloving/workspace/control.sock");

async function served(host: WorkspaceHost, busy: number) {
  await mkdir(host.runtime, { recursive: true });
  return listen({
    path: join(host.runtime, "control.sock"),
    handle: () =>
      Promise.resolve({
        kind: "result",
        result: { kind: "queue", queue: { busy } },
      }),
  });
}

await test("CLV-312 the supervisor gives each repository the permit socket, counts the active runs of all repositories against the workspace lanes and removes the socket at the end", async () => {
  const asked = Promise.withResolvers<Permit>();
  const result = await started({
    workspace: { ...pair, lanes: 1 },
    environment: { CLOVING_WATCH_PORT: "off" },
    hosted: async (host) => {
      const listener = await served(host, host.repository === alpha ? 1 : 0);
      try {
        if (host.repository !== alpha)
          asked.resolve(
            await workspacePermits(
              String(host.overrides["CLOVING_WORKSPACE_PERMITS"]),
            )(),
          );
        await asked.promise;
        return 0;
      } finally {
        await listener.close();
      }
    },
  });
  assert.equal(result.status, 0, result.refused);
  assert.deepEqual(
    result.hosts.map((host) => host.overrides),
    [
      { CLOVING_WATCH_PORT: "off", CLOVING_WORKSPACE_PERMITS: permits },
      { CLOVING_WATCH_PORT: "off", CLOVING_WORKSPACE_PERMITS: permits },
    ],
  );
  assert.deepEqual(await asked.promise, {
    kind: "held",
    hold: {
      reason: "workspace-lanes",
      busy: 1,
      limit: 1,
      text: "Held: 1 of 1 workspace lanes busy",
    },
  });
  assert.equal(existsSync(permits), false);
});
