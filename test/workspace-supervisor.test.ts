import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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

async function watchAddress(output: { readonly text: string }) {
  for (let waited = 0; waited < 500; waited += 1) {
    const [, address] =
      /Watch page: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output.text) ?? [];
    if (address !== undefined) return address;
    await delay(20);
  }
  throw new Error(`The workspace printed no watch address: ${output.text}`);
}

function cli(input: {
  readonly argumentsList: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  return execute(process.execPath, [entry, ...input.argumentsList], {
    cwd: input.cwd,
    env: input.environment,
    timeout: 20000,
  }).catch((error: unknown) => ({
    stdout: String(Reflect.get(Object(error), "stdout")),
    stderr: String(Reflect.get(Object(error), "stderr")),
  }));
}

async function assertWorkspaceStatus(input: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<void> {
  const status = await cli({ argumentsList: ["status"], ...input });
  assert.match(
    status.stdout,
    /^Workspace repositories:\n {2}alpha: service up, 0 active runs, 0 pending decisions\n {2}beta: service up, 0 active runs, 0 pending decisions\n/,
  );
  const summary = fields(
    JSON.parse(
      (await cli({ argumentsList: ["status", "--json"], ...input })).stdout,
    ),
  );
  assert.equal(summary["kind"], "workspace-status");
  assert.deepEqual(
    items(summary["repositories"]).map((repository) => [
      fields(repository)["name"],
      fields(repository)["service"],
    ]),
    [
      ["alpha", "up"],
      ["beta", "up"],
    ],
  );
  const selected = await cli({
    argumentsList: ["status", "--repository", "beta", "--json"],
    ...input,
  });
  assert.equal(fields(JSON.parse(selected.stdout))["kind"], "run-list");
}

await test("CLV-312 a workspace start keeps a supervisor record, serves one watch page for both repositories, and cloving status lists both repositories", async () => {
  const [alpha, beta] = [await scene(), await scene()];
  const state = join(alpha.root, "state");
  await writtenWorkspace(state, [
    { path: alpha.repository, name: "alpha" },
    { path: beta.repository, name: "beta" },
  ]);
  const environment = { ...hostEnvironment(state), CLOVING_WATCH_PORT: "0" };
  const host = await workspaceStarted({
    cwd: alpha.root,
    environment,
    guides: 2,
  });
  const record = join(state, "cloving/workspace/supervisor.json");
  try {
    assert.equal(existsSync(record), true);
    const address = await watchAddress(host.output);
    const model = fields(await (await fetch(`${address}data.json`)).json());
    assert.deepEqual(
      items(model["repositories"]).map(
        (repository) => fields(repository)["name"],
      ),
      ["alpha", "beta"],
    );
    await assertWorkspaceStatus({ cwd: alpha.root, environment });
    const second = await cli({
      argumentsList: ["start", "--workspace"],
      cwd: alpha.root,
      environment,
    });
    assert.match(second.stderr, /^workspace-already-running: /m);
    assert.equal(existsSync(record), true);
    host.child.kill("SIGTERM");
    assert.equal(await closed(host.child), 0, host.output.text);
    assert.equal(existsSync(record), false);
  } finally {
    await stopChildGroup(host.child);
  }
});
