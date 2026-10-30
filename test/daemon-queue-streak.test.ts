import assert from "node:assert/strict";
import { test } from "node:test";
import {
  declaredQueuePrelude as queuePrelude,
  queueWorkflow,
} from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

const sequence = `${queuePrelude}
const failures = () => JSON.parse(readFileSync("queue-commands.json", "utf8")).failures;
const finish = async (ticket, next, outcome) => {
  await until(() => existsSync("input-" + ticket));
  const [command] = commands();
  writeFileSync("ready", next);
  writeFileSync("outcome-" + ticket, outcome);
  await until(() => existsSync("input-" + next));
  return runIdentity(command);
};
`;

await test("CLV-131 explicit reset resumes a stopped queue while ordinary restart preserves its failures", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const stopped = await consumer.run(`${sequence}
const prior = ["run-first", "run-second", "run-third"];
writeFileSync("queue-commands.json", JSON.stringify({ commands: [], failures: prior }));
writeFileSync("ready", "CLV-900");
const daemon = await launched();
try {
  await delay(200);
  assert.deepEqual(failures(), prior);
  assert.equal((await runs()).length, 0);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stderr, /Queue stopped: 3 runs in a row/);
    const resumed = await consumer.run(`${sequence}
const daemon = await launched({ resetQueue: true });
try {
  await until(() => existsSync("input-CLV-900"));
  assert.deepEqual(failures(), []);
  const first = await finish("CLV-900", "CLV-901", "blocked");
  assert.deepEqual(failures(), [first]);
  assert.equal((await runs()).length, 2);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(resumed.stderr.includes("Queue stopped:"), false);
  }));

await test("CLV-131 resetting the failure streak preserves and observes a tracked run after a crash", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const first = await consumer.runUntil(
      "tracked",
      `${queuePrelude}
await launched({ queueMilliseconds: undefined });
await submitted("tracked-command");
await until(() => existsSync("input-CLV-900"));
writeFileSync("queue-commands.json", JSON.stringify({
  commands: ["tracked-command"], failures: ["run-first", "run-second", "run-third"]
}));
await halt("tracked");
`,
    );
    assert.deepEqual(first.lines, [{ boundary: "tracked" }], first.stderr);
    const second = await consumer.run(`${sequence}
const daemon = await launched({ resetQueue: true });
try {
  await until(() => failures().length === 0);
  assert.deepEqual(commands(), ["tracked-command"]);
  assert.equal((await runs()).length, 1);
  const runId = await finish("CLV-900", "CLV-901", "blocked");
  assert.equal(runId, runIdentity("tracked-command"));
  assert.deepEqual(failures(), [runId]);
  assert.equal((await runs()).length, 2);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stderr.includes("Queue stopped:"), false);
  }));

await test("CLV-131 handoff resets two blocked runs before two more blocked runs", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${sequence}
writeFileSync("ready", "CLV-900");
const daemon = await launched();
try {
  const first = await finish("CLV-900", "CLV-901", "blocked");
  const second = await finish("CLV-901", "CLV-902", "blocked");
  assert.deepEqual(failures(), [first, second]);
  await finish("CLV-902", "CLV-903", "handoff_requested");
  assert.deepEqual(failures(), []);
  const fourth = await finish("CLV-903", "CLV-904", "blocked");
  const fifth = await finish("CLV-904", "CLV-905", "blocked");
  assert.deepEqual(failures(), [fourth, fifth]);
  assert.equal((await runs()).length, 6);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr.includes("Queue stopped:"), false);
    assert.equal(
      result.stderr.split("\n").filter((line) => line.startsWith("Queue "))
        .length,
      4,
    );
  }));

await test("CLV-131 a failed issue update reports its reason while continuing and counts against the limit", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${sequence}
writeFileSync("ready", "CLV-900");
const daemon = await launched();
try {
  const runId = await finish("CLV-900", "CLV-901", JSON.stringify({
    kind: "handoff_requested", ticketStatus: "partial", issueUpdate: "failed"
  }));
  assert.deepEqual(failures(), [runId]);
  assert.equal((await runs()).length, 2);
  print({ runId });
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    const value = result.lines[0];
    assert.ok(value && typeof value === "object" && "runId" in value);
    assert.deepEqual(
      result.stderr.split("\n").filter((line) => line.startsWith("Queue ")),
      [
        `Queue run ended handoff_requested; issueUpdate: failed: ${String(value.runId)}; continuing`,
      ],
    );
  }));

await test("CLV-131 a crash preserves two failures and the next blocked run reaches the limit", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const first = await consumer.runUntil(
      "streak",
      `${sequence}
writeFileSync("ready", "CLV-900");
await launched();
await finish("CLV-900", "CLV-901", "blocked");
writeFileSync("ready", "");
writeFileSync("outcome-CLV-901", "blocked");
await until(() => failures().length === 2 && commands().length === 0);
await halt("streak", { runIds: failures() });
`,
    );
    const prior = first.lines[0];
    assert.ok(prior && typeof prior === "object" && "runIds" in prior);
    assert.ok(Array.isArray(prior.runIds));
    assert.ok(prior.runIds.every((id): id is string => typeof id === "string"));
    assert.equal(prior.runIds.length, 2);
    const second = await consumer.run(`${sequence}
writeFileSync("ready", "CLV-902");
const daemon = await launched();
try {
  await until(() => existsSync("input-CLV-902"));
  const [command] = commands();
  writeFileSync("ready", "CLV-903");
  writeFileSync("outcome-CLV-902", "blocked");
  await until(() => failures().length === 3);
  await delay(200);
  assert.equal((await runs()).length, 3);
  assert.deepEqual(commands(), []);
  print({ runId: runIdentity(command) });
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(second.status, 0, second.stderr);
    const current = second.lines[0];
    assert.ok(current && typeof current === "object" && "runId" in current);
    const runIds = [...prior.runIds.map(String), String(current.runId)];
    assert.deepEqual(
      second.stderr.split("\n").filter((line) => line.startsWith("Queue ")),
      [
        `Queue stopped: 3 runs in a row ended without handoff: ${runIds.join(", ")}`,
      ],
    );
  }));

await test("CLV-131 three blocked runs stop admissions with one diagnostic naming all three runs", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${sequence}
writeFileSync("ready", "CLV-900");
const daemon = await launched();
try {
  const first = await finish("CLV-900", "CLV-901", "blocked");
  const second = await finish("CLV-901", "CLV-902", "blocked");
  const [command] = commands();
  const third = runIdentity(command);
  writeFileSync("ready", "CLV-903");
  writeFileSync("outcome-CLV-902", "blocked");
  await until(() => failures().length === 3);
  await delay(200);
  assert.equal((await runs()).length, 3);
  assert.deepEqual(commands(), []);
  print({ runIds: [first, second, third] });
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    const value = result.lines[0];
    assert.ok(value && typeof value === "object" && "runIds" in value);
    assert.ok(Array.isArray(value.runIds));
    const lines = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("Queue "));
    assert.deepEqual(lines, [
      `Queue run ended blocked: ${String(value.runIds[0])}; continuing`,
      `Queue run ended blocked: ${String(value.runIds[1])}; continuing`,
      `Queue stopped: 3 runs in a row ended without handoff: ${value.runIds.join(", ")}`,
    ]);
  }));
