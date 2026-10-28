import assert from "node:assert/strict";
import { test } from "node:test";
import { queuePrelude, queueWorkflow } from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

const declared = `${queuePrelude}
const declaration = (workflowId, queue) => ({
  workflowId, queue, functionName: "custom", effectLimit: 1,
  capabilities: ["claude", "github"],
  input: { maximumBytes: 4096, fields: { ticket: { type: "ticket" } } },
});
settings.manifests.custom = settings.manifests.developTicket;
settings.workflows.custom = workflows.develop;
settings.declarations = [declaration("develop", true), declaration("other", false)];
`;

await test("CLV-218 bundled issue intake remains when declarations do not take the queue", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${declared}
settings.declarations = [declaration("develop", false)];
writeFileSync("ready", "900");
const daemon = await launched();
try {
  await until(() => existsSync("input-900"));
  assert.deepEqual((await runs()).map(run => run.workflowId), ["develop-issue"]);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-218 only the declared queue workflow receives queued tickets", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${declared}
writeFileSync("ready", "900");
const daemon = await launched();
try {
  await until(async () => (await runs()).length === 1);
  assert.deepEqual((await runs()).map(run => run.workflowId), ["develop"]);
  await until(() => existsSync("input-900"));
  assert.deepEqual(JSON.parse(readFileSync("input-900", "utf8")).input, {
    ticket: { id: "900", text: "# 900: Queue task" },
  });
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-218 declared queue dependency waits retain skip reasons", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${declared}
writeFileSync("next.mjs", 'const skipped = (process.env.CLOVING_SKIP_TICKETS ?? "").split(" "); process.stdout.write(["900", "901"].find(id => !skipped.includes(id)) ?? "");');
writeFileSync("ticket.mjs", 'const id = process.argv.at(-1); process.stdout.write("# Task " + id + (id === "900" ? "\\\\n## Dependencies\\\\nNeeds #899." : ""));');
writeFileSync("gh.mjs", 'import { existsSync } from "node:fs"; process.stdout.write(JSON.stringify({ state: existsSync("closed") ? "closed" : "open" }));');
const daemon = await launched({ queueLanes: 2, githubCommand: [process.execPath, directory + "/gh.mjs"] });
try {
  await until(() => existsSync("input-901"));
  const status = await asked("status");
  assert.deepEqual(status.queue.skipped.find(item => item.ticketId === "900"), { ticketId: "900", reason: "ticket-dependency-open", dependencies: ["899"] });
  assert.equal(existsSync("input-900"), false);
  writeFileSync("closed", "");
  await until(async () => (await runs()).length === 2);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Queue stopped:/);
  }));

await test("CLV-218 a declared queue preserves its failure streak until reset", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const first = await consumer.run(`${declared}
writeFileSync("ready", "900");
const failures = () => JSON.parse(readFileSync("queue-commands.json", "utf8")).failures;
const daemon = await launched();
try {
  for (const ticket of [900, 901, 902]) {
    await until(() => existsSync("input-" + ticket));
    writeFileSync("ready", String(ticket + 1));
    writeFileSync("outcome-" + ticket, "blocked");
    await until(() => failures().length === ticket - 899);
  }
  assert.equal((await runs()).length, 3);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /Queue stopped: 3 runs in a row/);
    const second = await consumer.run(`${declared}
let daemon = await launched();
await delay(100);
assert.equal((await runs()).length, 3);
await daemon.close();
daemon = await launched({ resetQueue: true });
try { await until(() => existsSync("input-903")); }
finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /Queue stopped: 3 runs in a row/);
  }));

await test("CLV-218 declared queue lanes and skips count active tickets", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${declared}
writeFileSync("next.mjs", \`import { appendFileSync } from "node:fs";
const skipped = process.env.CLOVING_SKIP_TICKETS ?? "";
appendFileSync("skips", JSON.stringify(skipped) + "\\\\n");
const id = ["900", "901", "902"].find(id => !skipped.split(" ").includes(id));
if (id) process.stdout.write(id);\`);
const daemon = await launched({ queueLanes: 2 });
try {
  await until(async () => (await runs()).length === 2);
  assert.equal((await submitted("full", { workflowId: "develop", submission: { ticket: "902" } })).code, "workflow-active");
  assert.equal((await submitted("duplicate", { workflowId: "develop", submission: { ticket: "900" } })).code, "ticket-active");
  assert.deepEqual(readFileSync("skips", "utf8").trim().split("\\n").map(JSON.parse), ["", "900"]);
  const status = await asked("status");
  assert.equal(status.queue.lanes, 2);
  assert.equal(status.queue.busy, 2);
  assert.deepEqual(status.queue.skipped.map(item => item.ticketId).sort(), ["900", "901"]);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

for (const retained of [false, true]) {
  await test(`CLV-218 moving the queue after a crash preserves and releases old lanes and tickets with old registration ${String(retained)}`, () =>
    withConsumer(queueWorkflow, async (consumer) => {
      const first = await consumer.runUntil(
        "old-queue",
        `${declared}
writeFileSync("ready", "900");
await launched({ queueLanes: 2 });
await until(() => existsSync("input-900"));
await halt("old-queue");
`,
      );
      assert.deepEqual(first.lines, [{ boundary: "old-queue" }], first.stderr);
      const second = await consumer.run(`${declared}
settings.declarations = [${retained ? 'declaration("develop", false),' : ""} declaration("other", true)];
writeFileSync("next.mjs", \`import { appendFileSync } from "node:fs";
const skipped = process.env.CLOVING_SKIP_TICKETS ?? "";
appendFileSync("skips", skipped + "\\\\n");
const id = ["900", "901", "902"].find(id => !skipped.split(" ").includes(id));
if (id) process.stdout.write(id);\`);
const daemon = await launched({ queueLanes: 2 });
try {
  await until(async () => (await runs()).length === 2);
  assert.deepEqual((await runs()).map(run => run.workflowId).sort(), ["develop", "other"]);
  assert.equal(readFileSync("skips", "utf8").trim(), "900");
  assert.equal((await submitted("old-ticket", { workflowId: "other", submission: { ticket: "900" } })).code, "ticket-active");
  assert.equal((await submitted("old-lane", { workflowId: "other", submission: { ticket: "902" } })).code, "workflow-active");
  assert.equal((await submitted("bundled-ticket", { workflowId: "develop-issue", submission: { ticket: "901" } })).code, "ticket-active");
${retained ? 'assert.equal((await submitted("former-ticket", { workflowId: "develop", submission: { ticket: "901" } })).code, "ticket-active");' : ""}
  assert.equal((await asked("status")).queue.busy, 2);
  const prior = (await runs()).find(run => run.workflowId === "develop");
  writeFileSync("next.mjs", 'process.stdout.write("902");');
  writeFileSync("outcome-900", "blocked");
  await until(async () => (await shown(prior.runId)).state === "completed");
  await until(async () => (await runs()).length === 3);
  const status = await asked("status");
  assert.equal(status.queue.busy, 2);
  assert.deepEqual(status.queue.skipped.map(item => item.ticketId).sort(), ["901", "902"]);
  assert.deepEqual(status.runs.map(run => run.workflowId).sort(), ["develop", "other", "other"]);
} finally { await daemon.close(); }
process.exit(0);
`);
      assert.equal(second.status, 0, second.stderr);
      assert.doesNotMatch(second.stderr, /Queue stopped:/);
    }));
}
