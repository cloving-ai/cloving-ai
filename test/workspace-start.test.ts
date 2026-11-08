import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runtimeDirectory } from "../src/cli/runtime-directory.ts";
import { fields } from "./service-fixture.ts";
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

await test("CLV-312 one start serves a workspace of two repositories, each with its own daemon, runtime directory and control socket, and a stop of the supervisor stops both", async () => {
  const [alpha, beta] = [await scene(), await scene()];
  const state = join(alpha.root, "state");
  await writtenWorkspace(state, [
    { path: alpha.repository, name: "alpha" },
    { path: beta.repository, name: "beta" },
  ]);
  const environment = hostEnvironment(state);
  const runtimes = [alpha.repository, beta.repository].map((repository) => {
    const runtime = runtimeDirectory({ XDG_STATE_HOME: state }, repository);
    assert.ok(runtime);
    return runtime;
  });
  assert.notEqual(runtimes[0], runtimes[1]);
  const host = await workspaceStarted({
    cwd: alpha.root,
    environment,
    guides: 2,
  });
  try {
    assert.match(host.output.text, /^ {2}alpha: .*\/repository$/m);
    assert.match(host.output.text, /^ {2}beta: .*\/repository$/m);
    for (const [index, repository] of [
      alpha.repository,
      beta.repository,
    ].entries()) {
      const runtime = String(runtimes[index]);
      assert.ok(
        host.output.text.includes(`Runtime directory: ${runtime}\n`),
        host.output.text,
      );
      assert.ok(existsSync(join(runtime, "control.sock")));
      const client = await execute(
        process.execPath,
        [entry, "status", "--repository", repository, "--json"],
        { cwd: alpha.root, env: environment, timeout: 10000 },
      );
      assert.equal(fields(JSON.parse(client.stdout))["kind"], "run-list");
    }
    host.child.kill("SIGTERM");
    assert.equal(await closed(host.child), 0, host.output.text);
    for (const runtime of runtimes)
      assert.equal(existsSync(join(runtime, "control.sock")), false);
  } finally {
    await stopChildGroup(host.child);
  }
});
