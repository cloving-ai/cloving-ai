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

await test("CLV-086 the daemon authorizes profiles using the registered workflow ID of the run", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
const { execFileSync } = await import("node:child_process");
execFileSync("git", ["init", "-q", "-b", "main"]);
writeFileSync("README.md", "fixture");
execFileSync("git", ["add", "README.md"]);
execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initialize"]);
writeFileSync("worker.mjs", \`for await (const chunk of process.stdin) String(chunk);
console.log(JSON.stringify({ type: "result", is_error: false, result: process.env.TURN_NAME }));\`);
const daemon = await launched({ queueMilliseconds: undefined,
  command: [process.execPath, directory + "/worker.mjs"],
  profiles: { checker: { env: { TURN_NAME: "{turn}" }, workflows: ["develop-issue"] } },
});
try {
  const accepted = await submitted("profile-check");
  await until(async () => (await shown(accepted.runId)).state === "completed");
  const run = await shown(accepted.runId);
  assert.equal(run.effects.length, 1);
  assert.equal(run.effects[0].state, "completed");
  const folders = readdirSync(directory + "/journal").filter((name) => name !== "targets");
  assert.equal(folders.length, 1);
  const outcome = JSON.parse(readFileSync(directory + "/journal/" + folders[0] + "/result.json", "utf8"));
  assert.equal(JSON.parse(outcome.result).summary, accepted.runId + "-" + folders[0]);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));
