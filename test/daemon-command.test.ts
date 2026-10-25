import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { queuePrelude } from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

const workflow = `
import { runCommand } from "cloving/workflows/steps/run-command";
export async function develop(input) {
  "use workflow";
  const result = await runCommand({ scope: { phase: "scan", operation: "reviews", round: 1 }, name: "scan", input: input.input });
  return { kind: "completed", command: result };
}
`;

const commandPrelude = `${queuePrelude}
writeFileSync("scan.workflow.json", JSON.stringify({ schemaVersion: 1, name: "develop", workflowId: definition.workflowId, steps: [], capabilities: ["command"], resources: [], artifacts: "artifacts" }));
const declaration = { functionName: "scan", workflowId: "review-queue", effectLimit: 1, capabilities: ["command"], commands: ["scan"], input: { maximumBytes: 64, fields: {} } };
const launch = () => launched({
  queueMilliseconds: undefined,
  declarations: [declaration],
  commands: { scan: [process.execPath, directory + "/scan.mjs"] },
  manifests: { ...settings.manifests, scan: directory + "/scan.workflow.json" },
  workflows: { ...settings.workflows, scan: workflows.develop },
});
const submit = () => asked("run", { workflowId: "review-queue", source: "input", submission: {}, commandId: "command-run" });
const commandShown = async (runId) => { const reply = await asked("status", { runId }); assert.ok(reply.run, JSON.stringify(reply)); return reply.run; };
const output = async () => {
  const runs = (await (await getWorld()).runs.list({})).data;
  return await getRun(runs[0].runId).returnValue;
};
`;

function stopCommand(directory: string): void {
  const path = join(directory, "command-pid");
  if (!existsSync(path)) return;
  try {
    process.kill(Number(readFileSync(path, "utf8")), "SIGKILL");
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ESRCH") throw error;
  }
}

await test("CLV-178 invalid UTF-8 at the stdout byte limit remains a completed replayable text result", () =>
  withConsumer(workflow, async (consumer) => {
    const result = await consumer.run(`${commandPrelude}
writeFileSync("scan.mjs", 'process.stdout.write(Buffer.alloc(1048576, 255));');
const daemon = await launch();
try {
  const admission = await submit();
  await until(async () => (await commandShown(admission.runId)).state === "completed");
  const result = await output();
  assert.equal(result.command.kind, "completed");
  assert.equal(result.command.result, "\\ufffd".repeat(1048576));
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-178 a declared compiled Local World workflow runs a real command and replays its one MiB result after daemon restart", () =>
  withConsumer(workflow, async (consumer) => {
    const first = await consumer.run(`${commandPrelude}
writeFileSync("scan.mjs", 'import { appendFileSync } from "node:fs"; let input = ""; for await (const chunk of process.stdin) input += chunk; appendFileSync("calls", input + "\\\\n"); process.stderr.write("private stderr"); process.stdout.write("x".repeat(1048576));');
const daemon = await launch();
try {
  const admission = await submit();
  assert.equal(admission.kind, "run-admitted", JSON.stringify(admission));
  await until(async () => (await commandShown(admission.runId)).state === "completed");
  const result = await output();
  assert.equal(result.command.kind, "completed", JSON.stringify(result.command));
  assert.equal(result.command.result.length, 1048576);
  const view = await commandShown(admission.runId);
  assert.equal(view.commandEffects.length, 1);
  assert.equal(view.commandEffects[0].name, "scan");
  assert.equal(view.commandEffects[0].exitCode, 0);
  assert.equal(typeof view.commandEffects[0].durationMilliseconds, "number");
  assert.equal(readFileSync("calls", "utf8"), "{}\\n");
  print({ runId: admission.runId });
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(first.status, 0, first.stderr);
    const restarted = await consumer.run(`${commandPrelude}
const daemon = await launch();
try {
  const replay = await submit();
  assert.equal(replay.kind, "run-admitted");
  assert.equal((await commandShown(replay.runId)).state, "completed");
  assert.equal((await commandShown(replay.runId)).commandEffects[0].exitCode, 0);
  assert.equal((await output()).command.result.length, 1048576);
  assert.equal(readFileSync("calls", "utf8"), "{}\\n");
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(restarted.status, 0, restarted.stderr);
  }));

await test("CLV-178 a daemon crash after a real command starts yields command-interrupted on Local World recovery without running it again", () =>
  withConsumer(workflow, async (consumer) => {
    try {
      const crashed = await consumer.runUntil(
        "command-started",
        `${commandPrelude}
writeFileSync("scan.mjs", 'import { appendFileSync, writeFileSync } from "node:fs"; appendFileSync("calls", "one\\\\n"); writeFileSync("command-pid", String(process.pid)); setInterval(() => {}, 1000);');
await launch();
const admission = await submit();
await until(() => existsSync("command-pid"));
await halt("command-started", { runId: admission.runId });
`,
      );
      assert.equal(crashed.status, null);
      const restarted = await consumer.run(`${commandPrelude}
const daemon = await launch();
try {
  const runId = (await asked("status")).runs[0].runId;
  await until(async () => (await commandShown(runId)).state === "completed");
  const result = await output();
  assert.equal(result.command.kind, "failed");
  assert.equal(result.command.reason, "command-interrupted");
  assert.equal(readFileSync("calls", "utf8"), "one\\n");
} finally { await daemon.close(); }
process.exit(0);
`);
      assert.equal(restarted.status, 0, restarted.stderr);
    } finally {
      stopCommand(consumer.directory);
    }
  }));
