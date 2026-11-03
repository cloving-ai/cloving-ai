import assert from "node:assert/strict";
import { test } from "node:test";
import { queuePrelude } from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

const workflow = `
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
export async function develop(input) {
  "use workflow";
  const effect = await protectedEffect({
    scope: { phase: "work", operation: "check", round: 1 },
    capability: "claude", method: "run-turn:checker", target: "review", payload: "Check the work", units: 1,
  });
  return { kind: "handoff_requested", effect };
}
`;

await test("CLV-271 daemon status names the archive of archived turn details and says when the retention rule deleted them", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
const { execFileSync } = await import("node:child_process");
execFileSync("git", ["init", "-q", "-b", "main"]);
writeFileSync("README.md", "fixture");
execFileSync("git", ["add", "README.md"]);
execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initialize"]);
writeFileSync("worker.mjs", \`for await (const chunk of process.stdin) String(chunk);
console.log(JSON.stringify({ type: "result", is_error: false, result: "done", total_cost_usd: 0.25 }));\`);
const day = 86400000;
const worker = { queueMilliseconds: undefined,
  command: [process.execPath, directory + "/worker.mjs"],
  profiles: { checker: { env: {}, workflows: ["develop"] } },
};
const later = (action) => ({ ...worker,
  retention: { days: 30, action, archiveFolder: null },
  retentionClock: () => Date.now() + 40 * day,
});
const finished = async (commandId) => {
  const accepted = await submitted(commandId, { workflowId: "develop" });
  assert.equal(accepted.kind, "run-admitted", JSON.stringify(accepted));
  await until(async () => (await shown(accepted.runId)).state === "completed");
  return accepted.runId;
};
const first = await launched(worker);
const archivedRun = await finished("archived-run");
await first.close();
const second = await launched(later("archive"));
const archived = await shown(archivedRun);
assert.deepEqual(archived.turnDetails, { state: "archived", folder: directory + "/archive/journal" });
assert.equal(archived.workerTurns.length, 1);
const deletedRun = await finished("deleted-run");
assert.equal((await shown(deletedRun)).turnDetails, undefined);
await second.close();
const third = await launched(later("delete"));
const deleted = await shown(deletedRun);
assert.deepEqual(deleted.turnDetails, { state: "deleted" });
assert.equal(deleted.workerTurns.length, 1);
assert.equal((await shown(archivedRun)).turnDetails.state, "archived");
await third.close();
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));
