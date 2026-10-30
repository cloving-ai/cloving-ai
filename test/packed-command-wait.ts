import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packedCommand } from "./packed-install-fixture.ts";

const compiledWaitScript = `
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { start, getRun } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { startHost } from "./node_modules/cloving/dist/src/host/world-host.js";
import { registerStepBridge } from "./node_modules/cloving/dist/src/host/step-bridge-host.js";
import * as workflows from "./wait-artifacts/client.mjs";
import { POST } from "./wait-artifacts/flow.mjs";
const host = await startHost({ dataDirectory: process.cwd() + "/wait-world", concurrency: 1, handler: POST });
assert.equal(host.kind, "started", JSON.stringify(host));
const requests = [];
let checks = 0;
const pending = { kind: "pending", deadline: Date.now() + 60000, nextCheckAt: Date.now() + 20 };
const remove = registerStepBridge({
  effect: async () => { throw new Error("unexpected-effect"); }, gate: async () => { throw new Error("unexpected-gate"); },
  openCommandWait: async request => { requests.push(request); return pending; },
  checkCommandWait: async request => { assert.deepEqual(request, { name: "team-review" }); checks += 1; return checks === 1 ? pending : { kind: "ready", value: { approved: true } }; },
});
try {
  const run = await start(workflows.commandWait, []);
  let completed = false;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await getRun(run.runId).status === "completed") { completed = true; break; }
    await delay(20);
  }
  assert.ok(completed, "compiled-command-wait-did-not-complete");
  assert.deepEqual(await getRun(run.runId).returnValue, { kind: "ready", value: { approved: true } });
  assert.deepEqual(requests, [{ name: "team-review", input: { change: 42 } }]);
  assert.equal(checks, 2);
  const events = (await (await getWorld()).events.list({ runId: run.runId })).data;
  assert.equal(events.filter(event => event.eventType === "wait_created").length, 1);
  assert.equal(events.filter(event => event.eventType === "step_retrying").length, 0);
} finally { remove(); await host.host.close(); }
`;

export async function packedCommandWait(root: string): Promise<void> {
  await mkdir(join(root, "wait-workflows"));
  await writeFile(
    join(root, "wait-workflows/wait.ts"),
    `
import { waitForCommand } from "cloving/workflows/steps/wait-for-command";
export async function commandWait() {
  "use workflow";
  return await waitForCommand({ name: "team-review", input: { change: 42 } });
}
`,
  );
  packedCommand(process.execPath, {
    args: [
      "node_modules/cloving/dist/tools/compile-workflows.js",
      "wait-workflows",
      "wait-artifacts",
    ],
    cwd: root,
  });
  await writeFile(join(root, "compiled-wait.mjs"), compiledWaitScript);
  packedCommand(process.execPath, {
    args: ["compiled-wait.mjs"],
    cwd: root,
    env: {
      ...process.env,
      WORKFLOW_TARGET_WORLD: "local",
      WORKFLOW_LOCAL_QUEUE_CONCURRENCY: "1",
      WORKFLOW_LOCAL_DATA_DIR: join(root, "wait-world"),
      WORKFLOW_LOCAL_BASE_URL: "http://127.0.0.1:1",
    },
  });
}
