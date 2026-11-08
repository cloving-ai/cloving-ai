import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import {
  liveWorkspace,
  memberDirectory,
  removeWorkspaceRecord,
  workspaceRecordPath,
  writeWorkspaceRecord,
  type WorkspaceRecord,
} from "../src/cli/workspace-record.ts";

const members = [
  { name: "alpha", repository: "/work/alpha", runtime: "/state/alpha/run" },
  { name: "beta", repository: "/work/beta", runtime: "/state/beta/run" },
];

function endedProcessId(): number {
  const ended = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.ok(typeof ended.pid === "number");
  return ended.pid;
}

async function withState(
  body: (environment: NodeJS.ProcessEnv, path: string) => Promise<void>,
): Promise<void> {
  const state = await mkdtemp(join(tmpdir(), "clv-workspace-record-"));
  const environment = { XDG_STATE_HOME: state };
  try {
    await body(environment, String(workspaceRecordPath(environment)));
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}

await test("CLV-312 the supervisor record of a workspace is in the runtime root or the state root", () => {
  assert.equal(
    workspaceRecordPath({ XDG_STATE_HOME: "/state" }),
    "/state/cloving/workspace/supervisor.json",
  );
  assert.equal(
    workspaceRecordPath({ XDG_RUNTIME_DIR: "/run/user", HOME: "/home/a" }),
    "/run/user/cloving/workspace/supervisor.json",
  );
  assert.equal(
    workspaceRecordPath({ HOME: "/home/a" }),
    "/home/a/.local/state/cloving/workspace/supervisor.json",
  );
  assert.equal(workspaceRecordPath({}), undefined);
});

await test("CLV-312 a written supervisor record is live while its process runs", async () => {
  await withState(async (environment, path) => {
    const written: WorkspaceRecord = { processId: process.pid, members };
    await writeWorkspaceRecord(path, written);
    assert.deepEqual(liveWorkspace(environment), written);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      schemaVersion: 1,
      ...written,
    });
  });
});

await test("CLV-312 a missing, invalid or ended supervisor record gives no workspace", async () => {
  await withState(async (environment, path) => {
    assert.equal(liveWorkspace(environment), undefined);
    assert.equal(liveWorkspace({}), undefined);
    await writeWorkspaceRecord(path, { processId: endedProcessId(), members });
    assert.equal(liveWorkspace(environment), undefined);
    await writeFile(path, "not json");
    assert.equal(liveWorkspace(environment), undefined);
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 1, processId: process.pid, members: [] }),
    );
    assert.equal(liveWorkspace(environment), undefined);
  });
});

await test("CLV-312 the supervisor removes only its own record", async () => {
  await withState(async (_environment, path) => {
    await writeWorkspaceRecord(path, { processId: process.pid, members });
    await removeWorkspaceRecord(path, process.pid + 1);
    assert.equal(existsSync(path), true);
    await removeWorkspaceRecord(path, process.pid);
    assert.equal(existsSync(path), false);
    await removeWorkspaceRecord(path, process.pid);
  });
});

await test("CLV-312 the repository option selects a workspace repository by its name, else it names a directory", () => {
  const record = { processId: process.pid, members };
  assert.equal(memberDirectory(record, "beta"), "/work/beta");
  assert.equal(memberDirectory(record, "../other"), "../other");
  assert.equal(memberDirectory(record, undefined), undefined);
  assert.equal(memberDirectory(undefined, "beta"), "beta");
});

await test("CLV-312 the watch command accepts the workspace option", () => {
  assert.deepEqual(parseInvocation(["watch", "--workspace"]), {
    kind: "watch",
    port: null,
    json: false,
    workspace: true,
  });
  assert.deepEqual(parseInvocation(["watch", "--port", "0"]), {
    kind: "watch",
    port: 0,
    json: false,
  });
});
