import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  workspaceRecordPath,
  writeWorkspaceRecord,
} from "../src/cli/workspace-record.ts";
import { fields, items, waitingGate, withHarness } from "./service-fixture.ts";
import { entry } from "./workspace-fixture.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "clv-workspace-status-")));
process.on("exit", () => {
  rmSync(root, { recursive: true, force: true });
});
const state = join(root, "state");
const outside = join(root, "outside");
const environment: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"],
  NODE_V8_COVERAGE: process.env["NODE_V8_COVERAGE"],
  XDG_STATE_HOME: state,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_RUNTIME_DIR: "",
};
await mkdir(outside);
execFileSync("git", ["init", "--quiet", outside]);

function cloving(argumentsList: readonly string[], directory = root) {
  const result = spawnSync(process.execPath, [entry, ...argumentsList], {
    cwd: directory,
    env: environment,
    encoding: "utf8",
    timeout: 20000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function servedStatus(): Promise<string> {
  const result = await promisify(execFile)(
    process.execPath,
    [entry, "status"],
    { cwd: root, env: environment, timeout: 20000 },
  );
  return result.stdout;
}

await test("CLV-312 cloving watch --workspace refuses to start with no running workspace", () => {
  const result = cloving(["watch", "--workspace", "--port", "0"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /workspace-not-running/);
  assert.match(result.stderr, /cloving start --workspace/);
});

await test("CLV-312 the workspace status names each repository whose service does not answer and exits with status 1", async () => {
  await writeWorkspaceRecord(String(workspaceRecordPath(environment)), {
    processId: process.pid,
    members: [
      {
        name: "alpha",
        repository: join(root, "alpha"),
        runtime: join(root, "alpha-run"),
      },
    ],
  });
  const human = cloving(["status"]);
  assert.equal(human.status, 1);
  assert.equal(
    human.stdout,
    "Workspace repositories:\n  alpha: service down, service-unavailable\nRun cloving status --repository <name> to show the runs of one repository.\n",
  );
  const json = cloving(["status", "--json"]);
  const [alpha] = items(fields(JSON.parse(json.stdout))["repositories"]);
  assert.equal(fields(alpha)["service"], "down");
  assert.equal(fields(fields(alpha)["error"])["code"], "service-unavailable");
  assert.equal(fields(alpha)["runtimeDirectory"], join(root, "alpha-run"));
});

await test("CLV-312 cloving status in a repository outside the workspace shows the status of that repository", () => {
  const result = cloving(["status"], outside);
  assert.doesNotMatch(result.stdout, /Workspace repositories/);
  assert.match(result.stderr, /service-unavailable/);
});

await test("CLV-312 cloving status with a run ID or a page option shows one repository, as before", () => {
  for (const options of [["run-1"], ["--limit", "5"]]) {
    const result = cloving(["status", ...options]);
    assert.doesNotMatch(result.stdout, /Workspace repositories/);
    assert.match(result.stderr, /repository-unknown/);
  }
});

await test("CLV-312 the workspace status counts the active runs and the pending decisions of a repository", async () => {
  await withHarness(async (harness) => {
    await waitingGate(harness, {
      service: await harness.start(),
      commandId: "gate",
      kind: "question",
    });
    await writeWorkspaceRecord(String(workspaceRecordPath(environment)), {
      processId: process.pid,
      members: [
        {
          name: "alpha",
          repository: join(root, "alpha"),
          runtime: harness.runtimeDirectory,
        },
      ],
    });
    assert.match(
      await servedStatus(),
      /^ {2}alpha: service up, 1 active run, 1 pending decision$/m,
    );
  });
});
