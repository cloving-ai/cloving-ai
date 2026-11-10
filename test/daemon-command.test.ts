import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { processExists } from "../src/daemon/process-identity.ts";
import { recordedLaunch } from "../src/turn-launch.ts";
import { until } from "./claude-worker-fixture.ts";
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

function killed(processId: number): void {
  try {
    process.kill(processId, "SIGKILL");
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ESRCH") throw error;
  }
}

function launchGroups(directory: string): readonly number[] {
  const commands = join(directory, "commands");
  if (!existsSync(commands)) return [];
  return readdirSync(commands).flatMap((name) => {
    const file = join(commands, name, "launch.json");
    if (!existsSync(file)) return [];
    const launch = recordedLaunch(JSON.parse(readFileSync(file, "utf8")));
    return launch === undefined ? [] : [launch.processId];
  });
}

async function stopCommand(directory: string): Promise<void> {
  const groups = launchGroups(directory);
  for (const group of groups) killed(-group);
  const path = join(directory, "command-pid");
  if (existsSync(path)) killed(Number(readFileSync(path, "utf8")));
  await until(() => groups.every((group) => !processExists(group)));
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

const launchRecorded = `async () => {
  const files = await import("node:fs");
  return files.existsSync("command-pid") && files.existsSync("commands") && files.readdirSync("commands").some((name) => files.existsSync("commands/" + name + "/launch.json"));
}`;

const crashScene = `${commandPrelude}
writeFileSync("scan.mjs", 'import { appendFileSync, existsSync, writeFileSync } from "node:fs"; appendFileSync("calls", "one\\\\n"); writeFileSync("command-pid", String(process.pid)); const wait = setInterval(() => { if (!existsSync("go")) return; clearInterval(wait); process.stdout.write("done"); }, 20);');
await launch();
const admission = await submit();
await until(${launchRecorded});
await halt("command-started", { runId: admission.runId });
`;

await test("CLV-337 after a daemon crash, the restarted daemon connects to the command that still runs and the run completes with its result", () =>
  withConsumer(workflow, async (consumer) => {
    try {
      const crashed = await consumer.runUntil("command-started", crashScene);
      assert.equal(crashed.status, null);
      const restarted = await consumer.run(`${commandPrelude}
const daemon = await launch();
try {
  const runId = (await asked("status")).runs[0].runId;
  writeFileSync("go", "");
  await until(async () => (await commandShown(runId)).state === "completed");
  const result = await output();
  assert.equal(result.command.kind, "completed", JSON.stringify(result.command));
  assert.equal(result.command.result, "done");
  assert.equal(readFileSync("calls", "utf8"), "one\\n");
} finally { await daemon.close(); }
process.exit(0);
`);
      assert.equal(restarted.status, 0, restarted.stderr);
    } finally {
      await stopCommand(consumer.directory);
    }
  }));

await test("CLV-337 a daemon close that keeps work keeps a real command running, and the next daemon connects to it and the run completes with its result", () =>
  withConsumer(workflow, async (consumer) => {
    try {
      const kept = await consumer.run(`${commandPrelude}
writeFileSync("scan.mjs", 'import { appendFileSync, existsSync, writeFileSync } from "node:fs"; appendFileSync("calls", "one\\\\n"); writeFileSync("command-pid", String(process.pid)); const wait = setInterval(() => { if (!existsSync("go")) return; clearInterval(wait); process.stdout.write("done"); }, 20);');
const daemon = await launch();
await submit();
await until(() => existsSync("command-pid"));
await daemon.close({ turns: "keep" });
process.kill(Number(readFileSync("command-pid", "utf8")), 0);
process.exit(0);
`);
      assert.equal(kept.status, 0, kept.stderr);
      const restarted = await consumer.run(`${commandPrelude}
const daemon = await launch();
try {
  const runId = (await asked("status")).runs[0].runId;
  writeFileSync("go", "");
  await until(async () => (await commandShown(runId)).state === "completed");
  const result = await output();
  assert.equal(result.command.kind, "completed", JSON.stringify(result.command));
  assert.equal(result.command.result, "done");
  assert.equal(readFileSync("calls", "utf8"), "one\\n");
} finally { await daemon.close(); }
process.exit(0);
`);
      assert.equal(restarted.status, 0, restarted.stderr);
    } finally {
      await stopCommand(consumer.directory);
    }
  }));

await test("CLV-178 a daemon crash after a real command starts yields command-interrupted on Local World recovery when the command process is gone, without running it again", () =>
  withConsumer(workflow, async (consumer) => {
    try {
      const crashed = await consumer.runUntil("command-started", crashScene);
      assert.equal(crashed.status, null);
      await stopCommand(consumer.directory);
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
      await stopCommand(consumer.directory);
    }
  }));

await test("CLV-178 failed command recovery releases the socket and ownership so startup can be retried", () =>
  withConsumer(workflow, async (consumer) => {
    try {
      const crashed = await consumer.runUntil(
        "command-started",
        `${commandPrelude}
writeFileSync("scan.mjs", 'import { writeFileSync } from "node:fs"; writeFileSync("command-pid", String(process.pid)); setInterval(() => {}, 1000);');
await launch();
await submit();
await until(${launchRecorded});
await halt("command-started");
`,
      );
      assert.equal(crashed.status, null);
      await stopCommand(consumer.directory);
      const restarted = await consumer.run(`${commandPrelude}
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const write = filesystem.writeFile;
let injected = 0;
filesystem.writeFile = async (file, ...args) => {
  if (String(file).includes("/commands/") && String(file).endsWith(".staged")) {
    injected += 1;
    throw Object.assign(new Error("command recovery disk full"), { code: "ENOSPC" });
  }
  return write(file, ...args);
};
syncBuiltinESMExports();
try {
  await assert.rejects(launch(), { code: "ENOSPC" });
  assert.ok(injected > 0);
  assert.equal(existsSync(runtimeDirectory + "/control.sock"), false);
} finally {
  filesystem.writeFile = write;
  syncBuiltinESMExports();
}
writeFileSync("scan.mjs", 'process.stdout.write("recovered");');
const daemon = await launch();
try {
  const admission = await asked("run", { workflowId: "review-queue", source: "input", submission: {}, commandId: "after-recovery" });
  assert.equal(admission.kind, "run-admitted");
  await until(async () => (await commandShown(admission.runId)).state === "completed");
  assert.equal((await commandShown(admission.runId)).commandEffects[0].exitCode, 0);
} finally { await daemon.close(); }
process.exit(0);
`);
      assert.equal(restarted.status, 0, restarted.stderr);
    } finally {
      await stopCommand(consumer.directory);
    }
  }));
