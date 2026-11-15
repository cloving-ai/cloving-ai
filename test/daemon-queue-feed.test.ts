import assert from "node:assert/strict";
import { test } from "node:test";
import { feedPrelude, feedWorkflow } from "./daemon-queue-feed-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

await test("CLV-362 an internal feed admits ordered inputs without ticket commands and stays off the floor", () =>
  withConsumer(feedWorkflow, async (consumer) => {
    const result = await consumer.run(
      `${feedPrelude}
const picks = [{ id: "900", text: "First" }, { id: "901", text: "Second" }];
writeFileSync("feed-result", JSON.stringify({ picks, skipped: [{ id: "801", reason: "needs a title" }] }));
const daemon = await launched({ queueLanes: 2, concurrency: 2 });
try {
  await until(() => existsSync("input-901"));
  assert.deepEqual(JSON.parse(readFileSync("input-900", "utf8")).input, { ticket: picks[0] });
  assert.deepEqual(JSON.parse(readFileSync("input-901", "utf8")).input, { ticket: picks[1] });
  assert.equal(readFileSync("feed-calls", "utf8"), "[null]\\n");
  await until(async () => (await asked("status")).queue.feed?.picks === 2);
  const status = await asked("status");
  assert.equal(status.runs.length, 2);
  assert.equal(status.queue.busy, 2);
  assert.equal(status.queue.feed.picks, 2);
  assert.deepEqual(status.queue.feed.skipped, [{ id: "801", reason: "needs a title" }]);
  assert.equal(existsSync("checks"), false);
} finally { await daemon.close(); }
process.exit(0);
`,
      { WORKFLOW_LOCAL_QUEUE_CONCURRENCY: "2" },
    );
    assert.equal(
      result.status,
      0,
      result.stderr + JSON.stringify(result.lines),
    );
  }));

await test("CLV-362 active picks are skipped in order while remaining picks fill free lanes", () =>
  withConsumer(feedWorkflow, async (consumer) => {
    const result = await consumer.run(`${feedPrelude}
writeFileSync("feed-result", JSON.stringify({ picks: [
  { id: "900", text: "Active" }, { id: "900", text: "Duplicate" }, { id: "901", text: "Next" }
], skipped: [] }));
const daemon = await launched({ queueLanes: 2 });
try {
  await until(async () => (await asked("status")).queue.feed !== undefined);
  const queue = (await asked("status")).queue;
  assert.equal(queue.busy, 2);
  assert.deepEqual(queue.feed.skipped, [{ id: "900", reason: "in work" }]);
  assert.ok(queue.skipped.some(item => item.ticketId === "900" && item.reason === "in work"));
  const inputs = (await runs()).map(run => run.input.ticket.id).sort();
  assert.deepEqual(inputs, ["900", "901"]);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

for (const value of [
  { picks: [{ id: "bad id", text: "Invalid" }], skipped: [] },
  { picks: [{ id: "900", text: "x".repeat(65_537) }], skipped: [] },
  {
    picks: Array.from({ length: 4 }, () => ({
      id: "900",
      text: "x".repeat(65_536),
    })),
    skipped: [],
  },
]) {
  await test(`CLV-362 an invalid feed result stops the cycle before admitting any pick (${String(JSON.stringify(value).length)})`, () =>
    withConsumer(feedWorkflow, async (consumer) => {
      const result = await consumer.run(`${feedPrelude}
writeFileSync("feed-result", ${JSON.stringify(JSON.stringify(value))});
const daemon = await launched();
try {
  await until(async () => (await asked("status")).queue.stop?.reason === "invalid-feed-result");
  assert.deepEqual(await runs(), []);
  assert.equal(existsSync("input-900"), false);
} finally { await daemon.close(); }
process.exit(0);
`);
      assert.equal(result.status, 0, result.stderr);
    }));
}

await test("CLV-362 ending queue work resets the empty-feed wait for the next interval", () =>
  withConsumer(feedWorkflow, async (consumer) => {
    const result = await consumer.run(
      `${feedPrelude}
writeFileSync("feed-result", JSON.stringify({ picks: [{ id: "900", text: "Work" }], skipped: [] }));
const daemon = await launched({ queueLanes: 2, queueMilliseconds: 500, concurrency: 2 });
try {
  await until(() => existsSync("input-900"));
  writeFileSync("feed-result", JSON.stringify({ picks: [], skipped: [] }));
  await until(async () => (await asked("status")).queue.feed?.picks === 0);
  const progress = await until(() => {
    const saved = JSON.parse(readFileSync("queues/develop/queue-feed.json", "utf8"));
    return saved.last?.picks === 0 && saved.notBefore > 0 ? saved : undefined;
  });
  assert.ok(progress.notBefore > Date.now());
  const count = () => readFileSync("feed-calls", "utf8").trim().split("\\n").length;
  const previous = count();
  writeFileSync("outcome-900", "handoff_requested");
  await until(() => count() > previous);
  assert.ok(Date.now() < progress.notBefore, "feed waited until its old empty-result deadline");
} finally { await daemon.close(); }
process.exit(0);
`,
      { WORKFLOW_LOCAL_QUEUE_CONCURRENCY: "2" },
    );
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-362 workspace capacity is checked again between feed picks", () =>
  withConsumer(feedWorkflow, async (consumer) => {
    const result = await consumer.run(`${feedPrelude}
import { createServer } from "node:net";
writeFileSync("feed-result", JSON.stringify({ picks: [{ id: "900", text: "First" }, { id: "901", text: "Second" }], skipped: [] }));
let permits = 0;
const hold = { reason: "workspace-lanes", busy: 2, limit: 2, text: "Held: 2 of 2 workspace lanes busy" };
const server = createServer(socket => socket.once("data", () => {
  permits += 1;
  socket.write(JSON.stringify({ ok: true, result: permits <= 2 ? { admitted: true } : { admitted: false, hold } }) + "\\n");
}));
await new Promise(ready => server.listen("feed-permits.sock", ready));
const daemon = await launched({ queueLanes: 2, workspacePermits: directory + "/feed-permits.sock" });
try {
  await until(async () => (await asked("status")).queue.hold?.reason === "workspace-lanes");
  const queue = (await asked("status")).queue;
  assert.equal(queue.busy, 1);
  assert.deepEqual((await runs()).map(run => run.input.ticket.id), ["900"]);
  assert.equal(existsSync("input-901"), false);
  assert.equal(readFileSync("feed-calls", "utf8").trim().split("\\n").length, 1);
} finally { await daemon.close(); server.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));
