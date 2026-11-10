import assert from "node:assert/strict";
import { test } from "node:test";
import { queuePrelude, queueWorkflow } from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

await test("CLV-312 a workspace member daemon asks the supervisor for a permit before it admits a queue run", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
import { createServer } from "node:net";
writeFileSync("ready", "CLV-900");
const supervisor = { admitted: false, asked: 0 };
const hold = { reason: "workspace-lanes", busy: 2, limit: 2, text: "Held: 2 of 2 workspace lanes busy" };
const server = createServer((socket) => {
  socket.once("data", () => {
    supervisor.asked += 1;
    const result = supervisor.admitted
      ? { kind: "workspace-permit", admitted: true }
      : { kind: "workspace-permit", admitted: false, hold };
    socket.write(JSON.stringify({ ok: true, result }) + "\\n");
  });
});
await new Promise((ready) => server.listen("permits.sock", ready));
const queueOf = async () => (await asked("status")).queue;
const daemon = await launched({
  queueLimits: { lanes: 1, workingLanes: 1 },
  workspacePermits: directory + "/permits.sock",
});
try {
  await until(async () => (await queueOf()).hold?.reason === "workspace-lanes");
  assert.deepEqual((await queueOf()).hold, hold);
  await delay(200);
  assert.deepEqual(await runs(), []);
  supervisor.admitted = true;
  await until(async () => (await runs()).length === 1);
  await until(async () => (await queueOf()).hold === null);
} finally { await daemon.close(); server.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Queue held: 2 of 2 workspace lanes busy/);
  }));
