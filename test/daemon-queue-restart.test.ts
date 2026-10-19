import assert from "node:assert/strict";
import { test } from "node:test";
import { queuePrelude, queueWorkflow } from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

const blockedAfterRestart = `${queuePrelude}
writeFileSync("outcome-CLV-900", "blocked");
writeFileSync("ready", "CLV-901");
const daemon = await launched();
try {
  const [prior] = await runs();
  await until(async () => (await shown(prior.runId)).state === "completed");
  await until(() => existsSync("input-CLV-901"));
  assert.equal((await runs()).length, 2);
  print({ runId: prior.runId });
} finally { await daemon.close(); }
process.exit(0);
`;

await test("CLV-131 an active queue run survives a crash and its blocked outcome releases the restarted queue", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const first = await consumer.runUntil(
      "active",
      `${queuePrelude}
writeFileSync("ready", "CLV-900");
await launched();
await until(() => existsSync("input-CLV-900"));
assert.equal(commands().length, 1);
await halt("active");
`,
    );
    assert.deepEqual(first.lines, [{ boundary: "active" }], first.stderr);
    const second = await consumer.run(blockedAfterRestart);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /Queue run ended blocked: run-.*; continuing/);
  }));

await test("CLV-084 a command persisted before a lost admission reply recovers its run on restart", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const first = await consumer.runUntil(
      "lost-reply",
      `${queuePrelude}
await launched({ queueMilliseconds: undefined });
writeFileSync("queue-commands.json", JSON.stringify(["lost-admission"]));
const reply = await submitted("lost-admission");
assert.equal(reply.runId, runIdentity("lost-admission"));
await until(() => existsSync("input-CLV-900"));
await halt("lost-reply");
`,
    );
    assert.deepEqual(first.lines, [{ boundary: "lost-reply" }], first.stderr);
    const second = await consumer.run(blockedAfterRestart);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /Queue run ended blocked: run-.*; continuing/);
  }));

await test("CLV-084 a handled blocked run is removed so the next daemon can admit a ready ticket", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const first = await consumer.run(`${queuePrelude}
writeFileSync("ready", "CLV-900");
const daemon = await launched();
try {
  await until(() => existsSync("input-CLV-900"));
  writeFileSync("ready", "");
  writeFileSync("outcome-CLV-900", "blocked");
  const run = await until(async () => (await runs())[0]);
  await until(async () => (await shown(run.runId)).state === "completed");
  await until(() => commands().length === 0);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /Queue run ended blocked: run-.*; continuing/);
    const second = await consumer.run(`${queuePrelude}
writeFileSync("ready", "CLV-901");
const daemon = await launched();
try { await until(() => existsSync("input-CLV-901")); }
finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stderr.includes("Queue stopped:"), false);
  }));

await test("CLV-084 a command with no run is removed on restart before the next submission", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
writeFileSync("queue-commands.json", JSON.stringify(["never-admitted"]));
writeFileSync("ready", "CLV-900");
const daemon = await launched();
try {
  await until(() => existsSync("input-CLV-900"));
  assert.equal(commands().includes("never-admitted"), false);
  assert.equal(commands().length, 1);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));
