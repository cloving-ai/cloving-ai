import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../src/daemon/daemon.ts";
import {
  hostEnvironment,
  worldDirectory,
} from "../src/daemon/host-environment.ts";

const declaration = {
  workflowId: "project-run",
  functionName: "develop",
  effectLimit: 1,
  capabilities: ["claude"],
  input: { maximumBytes: 4096, fields: {} },
} as const;

await test("CLV-010 the host environment names the Local World of the host directory, its queue bound and the ownership lease", () => {
  assert.deepEqual(hostEnvironment({ directory: "/host", concurrency: 8 }), {
    WORKFLOW_TARGET_WORLD: "local",
    WORKFLOW_LOCAL_DATA_DIR: "/host/world",
    WORKFLOW_LOCAL_BASE_URL: "http://127.0.0.1:1",
    WORKFLOW_LOCAL_QUEUE_CONCURRENCY: "8",
    WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS: "15",
  });
  assert.equal(worldDirectory("/host"), "/host/world");
  assert.equal(
    hostEnvironment({ directory: "/host", concurrency: 1, leaseSeconds: 2 })[
      "WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS"
    ],
    "2",
  );
});

await test("CLV-010 the daemon refuses to start with a workflow manifest that is not admitted, and it makes no state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloving-daemon-"));
  try {
    const opening = await startDaemon({
      directory,
      runtimeDirectory: join(directory, "run"),
      repository: directory,
      manifests: { develop: join(directory, "cloving.workflow.json") },
      declarations: [declaration],
      workflows: {},
      handler: () => Promise.resolve(new Response("")),
      command: ["true"],
      concurrency: 1,
    });
    assert.deepEqual(opening, {
      kind: "refused",
      reason: "workflow-rejected",
      detail: "invalid-manifest: schemaVersion or artifacts",
    });
    assert.equal(existsSync(join(directory, "state")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("CLV-074 the daemon refuses a registration whose function has no manifest before creating state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloving-daemon-"));
  try {
    const opening = await startDaemon({
      directory,
      runtimeDirectory: join(directory, "run"),
      repository: directory,
      manifests: {},
      declarations: [declaration],
      workflows: {},
      handler: () => Promise.resolve(new Response("")),
      command: ["true"],
      concurrency: 1,
    });
    assert.deepEqual(opening, {
      kind: "refused",
      reason: "workflow-rejected",
      detail: "Missing manifest for workflow function develop.",
    });
    assert.equal(existsSync(join(directory, "state")), false);
    assert.equal(existsSync(join(directory, "run")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
