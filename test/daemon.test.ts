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
import { withConsumer } from "./world-host-fixture.ts";
import { queuePrelude } from "./daemon-queue-fixture.ts";
import { importId, manifest, sidecar, corpus } from "./chats-worker-fixture.ts";
import { candidate } from "./chats-analysis-fixture.ts";

const analysisWorkflow = `
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
export async function develop(input) {
  "use workflow";
  const importId = input.input.importId;
  const read = await protectedEffect({ scope: { phase: "analysis", operation: "read", round: 1 }, capability: "chats", method: "read-analysis", target: importId, payload: JSON.stringify({ importId }), units: 1 });
  if (read.kind !== "completed") return { kind: "blocked", reason: JSON.stringify(read) };
  const snapshot = JSON.parse(read.result).snapshot;
  const save = await protectedEffect({ scope: { phase: "analysis", operation: "save", round: 1 }, capability: "chats", method: "save-analysis", target: importId, payload: JSON.stringify({ importId, cycleId: input.cycleId, snapshot, reply: input.input.reply }), units: 1 });
  if (save.kind !== "completed") return { kind: "blocked", reason: JSON.stringify(save) };
  return JSON.parse(save.result);
}
export async function placeholder() { "use workflow"; return { kind: "blocked", reason: "unused synthetic registration" }; }
`;

await test("CLV-115 daemon routes both protected chats methods without a model turn", () =>
  withConsumer(analysisWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
const { mkdirSync } = await import("node:fs");
const base = runtimeDirectory + "/chats/${importId}";
mkdirSync(base, { recursive: true, mode: 0o700 });
writeFileSync(base + "/redaction.json", ${JSON.stringify(JSON.stringify(manifest))});
writeFileSync(base + "/structure.json", ${JSON.stringify(JSON.stringify(sidecar))});
writeFileSync(base + "/redacted.jsonl", ${JSON.stringify(corpus)});
const definitions = Object.values(compiled.workflows).flatMap(Object.values);
const analysisDefinition = definitions.find((entry) => entry.workflowId.endsWith("//develop"));
const placeholder = definitions.find((entry) => entry.workflowId.endsWith("//placeholder"));
const manifest = { ...JSON.parse(readFileSync("develop.workflow.json", "utf8")), workflowId: analysisDefinition.workflowId };
writeFileSync("develop.workflow.json", JSON.stringify({ ...manifest, workflowId: placeholder.workflowId }));
writeFileSync("analysis.workflow.json", JSON.stringify({ ...manifest, capabilities: ["chats"] }));
const daemon = await launched({ queueMilliseconds: undefined,
  manifests: { ...settings.manifests, analyze: directory + "/analysis.workflow.json" },
  workflows: { developTicket: workflows.placeholder, developPrd: workflows.placeholder, analyze: workflows.develop },
  declarations: [{ workflowId: "analyze-chats", functionName: "analyze", effectLimit: 2, capabilities: ["chats"], input: { maximumBytes: 16000, fields: { importId: { type: "string" }, reply: { type: "string" } } } }],
});
try {
  const admitted = await asked("run", { workflowId: "analyze-chats", source: "declared", commandId: "analysis", submission: { importId: "${importId}", reply: ${JSON.stringify(JSON.stringify(candidate()))} } });
  assert.equal(admitted.kind, "run-admitted", JSON.stringify(admitted));
  const completed = await until(async () => { const value = await shown(admitted.runId); return ["completed", "blocked", "failed"].includes(value?.state) ? value : undefined; }).catch(async () => { throw new Error(JSON.stringify(await shown(admitted.runId))); });
  assert.equal(completed.outcome?.kind, "handoff_requested", JSON.stringify(completed));
  assert.ok(readdirSync(base).some((name) => name.startsWith("analysis-task-")));
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

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
      manifests: { developTicket: join(directory, "cloving.workflow.json") },
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
      workflows: {},
      handler: () => Promise.resolve(new Response("")),
      command: ["true"],
      concurrency: 1,
    });
    assert.deepEqual(opening, {
      kind: "refused",
      reason: "workflow-rejected",
      detail: "Missing manifest for workflow function developTicket.",
    });
    assert.equal(existsSync(join(directory, "state")), false);
    assert.equal(existsSync(join(directory, "run")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
