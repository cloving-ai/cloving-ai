import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fields, items } from "./service-fixture.ts";
import { scene } from "./self-host-fixture.ts";
import { stopChildGroup } from "./stop-child.ts";
import {
  closed,
  entry,
  hostEnvironment,
  workspaceStarted,
  writtenWorkspace,
} from "./workspace-fixture.ts";

const execute = promisify(execFile);

await test("CLV-312 cloving restart restarts both daemons of a running workspace at a common gap, and each service gets a new start time", async () => {
  const [alpha, beta] = [await scene(), await scene()];
  const state = join(alpha.root, "state");
  await writtenWorkspace(state, [
    { path: alpha.repository, name: "alpha" },
    { path: beta.repository, name: "beta" },
  ]);
  const environment = hostEnvironment(state);
  const host = await workspaceStarted({
    cwd: alpha.root,
    environment,
    guides: 2,
  });
  try {
    const restarted = await execute(
      process.execPath,
      [entry, "restart", "--json"],
      { cwd: alpha.root, env: environment, timeout: 60000 },
    );
    const shown = fields(JSON.parse(restarted.stdout));
    assert.equal(shown["kind"], "workspace-restart");
    assert.deepEqual(
      items(shown["repositories"]).map((repository) => [
        fields(repository)["name"],
        typeof fields(repository)["serviceStartedAt"],
      ]),
      [
        ["alpha", "string"],
        ["beta", "string"],
      ],
    );
    assert.equal(
      host.output.text.split("Commands for a second terminal:").length > 4,
      true,
      host.output.text,
    );
    host.child.kill("SIGTERM");
    assert.equal(await closed(host.child), 0, host.output.text);
  } finally {
    await stopChildGroup(host.child);
  }
});
