import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startSelection } from "../src/cli/start-arguments.ts";
import type { WorkspaceHost } from "../src/cli/workspace-start.ts";
import {
  workspaceRecordPath,
  writeWorkspaceRecord,
} from "../src/cli/workspace-record.ts";
import { alpha, beta, pair, root, started } from "./workspace-start-harness.ts";

await test("CLV-312 a workspace start refuses a missing or invalid workspace file before it starts a daemon", async () => {
  const missing = await started({ workspace: undefined });
  assert.equal(missing.status, 1);
  assert.match(
    missing.refused,
    /^workspace-missing: Cloving cannot read \/.*\/cloving\/workspace\.json\. Write the workspace file first\. See cloving start --help\.\n$/,
  );
  const invalid = await started({ workspace: "{" });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.refused, "invalid-workspace: the file is not JSON.\n");
  assert.deepEqual([...missing.hosts, ...invalid.hosts], []);
  assert.equal(missing.printed + invalid.printed, "");
});

await test("CLV-312 a workspace start refuses unknown, duplicate and runtime-sharing repositories", async () => {
  const unknown = await started({
    workspace: pair,
    repositories: { [alpha]: alpha },
  });
  assert.equal(
    unknown.refused,
    `workspace-repository-unknown: beta: ${beta} is not a git repository.\n`,
  );
  const duplicate = await started({
    workspace: pair,
    repositories: { [alpha]: alpha, [beta]: alpha },
  });
  assert.equal(
    duplicate.refused,
    `workspace-repository-duplicate: alpha and beta name the same repository ${alpha}.\n`,
  );
  const shared = await started({
    workspace: pair,
    environment: { CLOVING_RUNTIME_DIR: join(root, "shared") },
  });
  assert.equal(
    shared.refused,
    `workspace-runtime-shared: alpha and beta use the same runtime directory ${join(root, "shared")}. Unset CLOVING_RUNTIME_DIR.\n`,
  );
  const homeless = await started({
    workspace: pair,
    environment: { XDG_STATE_HOME: undefined },
  });
  assert.equal(
    homeless.refused,
    "workspace-runtime-unknown: Set HOME, XDG_STATE_HOME or XDG_RUNTIME_DIR.\n",
  );
  for (const result of [unknown, duplicate, shared, homeless]) {
    assert.equal(result.status, 1);
    assert.deepEqual(result.hosts, []);
  }
});

await test("CLV-312 each repository gets its own runtime directory, the start options and no watch child", async () => {
  const result = await started({
    workspace: pair,
    environment: { CLOVING_WATCH_PORT: "3663" },
  });
  assert.equal(result.status, 0);
  assert.equal(result.refused, "");
  assert.match(result.printed, /^Cloving workspace: \/.*workspace\.json\n/);
  assert.ok(result.printed.endsWith(`  alpha: ${alpha}\n  beta: ${beta}\n`));
  assert.deepEqual(
    result.hosts.map((host) => host.repository),
    [alpha, beta],
  );
  assert.notEqual(result.hosts[0]?.runtime, result.hosts[1]?.runtime);
  for (const host of result.hosts) {
    assert.ok(host.runtime.startsWith(join(root, "state/cloving/")));
    assert.deepEqual(host.overrides, { CLOVING_WATCH_PORT: "off" });
    assert.deepEqual(host.options, ["--reset-queue"]);
  }
  assert.deepEqual(
    result.watches.map((watch) => [watch.port, watch.signal.aborted]),
    [["3663", true]],
  );
});

await test("CLV-312 the supervisor starts one watch page on the default port and none when the port is off", async () => {
  const shown = await started({ workspace: pair });
  assert.deepEqual(
    shown.watches.map((watch) => watch.port),
    ["3663"],
  );
  const off = await started({
    workspace: pair,
    environment: { CLOVING_WATCH_PORT: "off" },
  });
  assert.equal(off.status, 0);
  assert.deepEqual(off.watches, []);
});

await test("CLV-312 a workspace start refuses to start while another workspace supervisor runs", async () => {
  const path = String(
    workspaceRecordPath({ XDG_STATE_HOME: join(root, "state") }),
  );
  await writeWorkspaceRecord(path, {
    processId: process.ppid,
    members: [{ name: "other", repository: alpha, runtime: join(root, "run") }],
  });
  const result = await started({ workspace: pair });
  assert.equal(result.status, 1);
  assert.equal(
    result.refused,
    `workspace-already-running: The workspace supervisor with process ID ${String(process.ppid)} runs. Stop it first.\n`,
  );
  assert.deepEqual(result.hosts, []);
  assert.deepEqual(result.watches, []);
  const again = await started({ workspace: pair });
  assert.equal(again.refused, result.refused);
  rmSync(path);
});

function heldHost(): Promise<number> {
  return new Promise((settle) => {
    setTimeout(() => {
      settle(0);
    }, 1000);
  });
}

await test("CLV-312 of two workspace starts at the same time, only one starts its repositories", async () => {
  const results = await Promise.all([
    started({ workspace: pair, hosted: heldHost }),
    started({ workspace: pair, hosted: heldHost }),
  ]);
  assert.deepEqual(results.map((result) => result.status).toSorted(), [0, 1]);
  assert.deepEqual(
    results
      .map((result) => /^workspace-already-running: /.test(result.refused))
      .toSorted(),
    [false, true],
  );
  assert.equal(results.flatMap((result) => result.hosts).length, 2);
});

await test("CLV-312 a workspace start refuses a place with no runtime root for its supervisor record", async () => {
  const result = await started({
    workspace: { version: 1, repositories: [{ path: alpha, name: "alpha" }] },
    environment: {
      XDG_STATE_HOME: "",
      CLOVING_RUNTIME_DIR: join(root, "explicit"),
    },
  });
  assert.equal(result.status, 1);
  assert.equal(
    result.refused,
    "workspace-runtime-unknown: Set HOME, XDG_STATE_HOME or XDG_RUNTIME_DIR.\n",
  );
  assert.deepEqual(result.hosts, []);
});

async function alphaFails(host: WorkspaceHost): Promise<number> {
  if (host.repository === alpha) return 3;
  await new Promise((resolve) => {
    host.signal.addEventListener("abort", resolve);
  });
  return 0;
}

await test("CLV-312 when one repository ends with an error, the supervisor stops the other repositories", async () => {
  const result = await started({
    workspace: pair,
    hosted: alphaFails,
  });
  assert.equal(result.status, 1);
  assert.equal(
    result.refused,
    "workspace-repository-ended: alpha ended with status 3. Cloving stops the other repositories.\n",
  );
  assert.ok(result.hosts.every((host) => host.signal.aborted));
});

await test("CLV-312 a repository that stops with status 0 after a stop signal sends no second stop to the other repositories", async () => {
  const result = await started({ workspace: pair });
  assert.equal(result.status, 0);
  assert.equal(result.hosts.length, 2);
  assert.ok(result.hosts.every((host) => !host.signal.aborted));
});

await test("CLV-312 start takes --workspace without --repository", () => {
  assert.deepEqual(startSelection(["--workspace", "--reset-queue"]), {
    kind: "workspace",
    options: ["--reset-queue"],
  });
  assert.deepEqual(startSelection(["--workspace", "--help"]), {
    kind: "usage",
  });
  assert.deepEqual(startSelection(["--workspace", "--repository", "/a"]), {
    kind: "refused",
    text: "unexpected-argument: --workspace and --repository do not go together.\n",
  });
  assert.deepEqual(startSelection(["--repository=/a"]), {
    kind: "repository",
    directory: "/a",
  });
  assert.deepEqual(startSelection([]), {
    kind: "repository",
    directory: undefined,
  });
  assert.deepEqual(startSelection(["--repository="]), {
    kind: "refused",
    text: "missing-value: --repository needs a directory.\n",
  });
  assert.deepEqual(startSelection(["--workspace", "extra"]), {
    kind: "refused",
    text: "unexpected-argument: run cloving start --help for usage.\n",
  });
});
