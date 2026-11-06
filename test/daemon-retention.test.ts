import assert from "node:assert/strict";
import { test } from "node:test";
import { notifyPrelude, notifyWorkflow } from "./daemon-notify-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

await test("CLV-270 the daemon start archives the records of an old finished run before it returns and keeps the records of a run at a gate", () =>
  withConsumer(notifyWorkflow, async (consumer) => {
    const result = await consumer.run(`${notifyPrelude}
import { mkdirSync } from "node:fs";
const day = 86400000;
const first = await launched({ notifyCommand: undefined });
const finished = await submitNotice("finished", { kind: "blocked" });
const waiting = await submitNotice("waiting");
await until(async () => (await shown(finished)).state === "completed");
await until(async () => (await shown(waiting)).state === "waiting_gate");
await first.close();
for (const [path, runId] of [["journal/finished-turn", finished], ["github/finished-effect", finished], ["journal/waiting-turn", waiting], ["journal/unknown-turn", "run-unknown"]]) {
  mkdirSync(path, { recursive: true });
  writeFileSync(path + "/started.json", JSON.stringify({ runId }));
}
const second = await launched({
  notifyCommand: undefined,
  retention: { days: 30, action: "archive", archiveFolder: null },
  retentionClock: () => Date.now() + 40 * day,
});
assert.equal(existsSync("archive/journal/finished-turn/started.json"), true);
assert.equal(existsSync("archive/github/finished-effect/started.json"), true);
assert.equal(existsSync("journal/finished-turn"), false);
assert.equal(existsSync("journal/waiting-turn/started.json"), true);
assert.equal(existsSync("journal/unknown-turn/started.json"), true);
await second.close();
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stderr,
      /retention: archived 2, kept 0, skipped 1 \(active runs\), unreadable 1\n/,
    );
    assert.match(
      result.stderr,
      /retention: removed 0 work trees, kept 0 with an open pull request\n/,
    );
  }));
