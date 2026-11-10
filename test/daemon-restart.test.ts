import assert from "node:assert/strict";
import { test } from "node:test";
import { queuePrelude, queueWorkflow } from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

await test("CLV-306 CLV-337 the daemon status shows the commit, the start time and the end of the turn recovery, and a restart leaves its mark for the host", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
const commit = "0123456789abcdef0123456789abcdef01234567";
const before = Date.now();
const settingSources = { "merge.mode": "environment", "queue.lanes": "default" };
const daemon = await launched({ commit, settingSources });
try {
  const status = await asked("status");
  assert.equal(status.serviceCommit, commit);
  assert.deepEqual(status.settingSources, settingSources);
  const startedAt = Date.parse(status.serviceStartedAt);
  assert.ok(startedAt >= before && startedAt <= Date.now(), status.serviceStartedAt);
  assert.equal(status.restart, null);
  assert.deepEqual(status.turnRecovery, { state: "done", connected: [], resumed: [], commands: [] });
  const reply = await asked("restart", { at: "gap", commandId: "restart-one" });
  assert.equal(reply.restart.state, "pending", JSON.stringify(reply));
  const { readdirSync } = await import("node:fs");
  const names = readdirSync(".").filter((name) => name.startsWith("pending-restart-"));
  assert.equal(names.length, 1, names.join(" "));
  const mark = JSON.parse(readFileSync(names[0], "utf8"));
  assert.equal(mark.at, "gap");
  assert.equal(mark.commandId, "restart-one");
  assert.deepEqual((await asked("status")).restart, { ...mark, activeRuns: 0 });
  await delay(200);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Queue holding for pending restart/);
  }));
