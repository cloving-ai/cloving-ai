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

await test("CLV-329 the daemon gives the masked transcript of a finished agent turn from its journal", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
const { execFileSync } = await import("node:child_process");
execFileSync("git", ["init", "-q", "-b", "main"]);
writeFileSync("README.md", "fixture");
execFileSync("git", ["add", "README.md"]);
execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initialize"]);
writeFileSync("worker.mjs", \`for await (const chunk of process.stdin) String(chunk);
const line = (value) => console.log(JSON.stringify(value));
line({ type: "assistant", message: { content: [{ type: "text", text: "Checked the Acme Secret work." }] } });
line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo ghp_token123" } }] } });
line({ type: "result", is_error: false, subtype: "success", result: "done", total_cost_usd: 0.25 });\`);
const daemon = await launched({
  queueMilliseconds: undefined,
  command: [process.execPath, directory + "/worker.mjs"],
  profiles: { checker: { env: {}, workflows: ["develop"] } },
  privateTexts: ["acme secret"],
});
const accepted = await submitted("transcript-run", { workflowId: "develop" });
assert.equal(accepted.kind, "run-admitted", JSON.stringify(accepted));
await until(async () => (await shown(accepted.runId)).state === "completed");
const [turn] = (await shown(accepted.runId)).workerTurns;
const page = await asked("transcript", { runId: accepted.runId, operationId: turn.operationId });
assert.equal(page.open, false, JSON.stringify(page));
assert.deepEqual(page.entries.map((entry) => [entry.kind, entry.summary || entry.text]), [
  ["assistant", "Checked the [hidden] work."],
  ["tool-call", "Bash: echo [hidden]"],
  ["result", "Turn end: success · cost 0.25 USD"],
]);
await daemon.close();
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));
