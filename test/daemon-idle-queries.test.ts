import assert from "node:assert/strict";
import { test } from "node:test";
import { queuePrelude, queueWorkflow } from "./daemon-queue-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";
import { withConsumer } from "./world-host-fixture.ts";

const idleMilliseconds = 60_000;

const statementCount = `
import * as idleSqlite from "node:sqlite";
const idleStatements = new Map();
const counting = { on: false };
const recorded = (sql) => {
  if (counting.on) idleStatements.set(sql, (idleStatements.get(sql) ?? 0) + 1);
};
for (const method of ["all", "get", "run", "iterate"]) {
  const original = idleSqlite.StatementSync.prototype[method];
  idleSqlite.StatementSync.prototype[method] = function (...parameters) {
    recorded(this.sourceSQL);
    return original.apply(this, parameters);
  };
}
const execute = idleSqlite.DatabaseSync.prototype.exec;
idleSqlite.DatabaseSync.prototype.exec = function (sql) {
  recorded(sql);
  return execute.call(this, sql);
};
`;

await test("CLV-284 after a finished run, with no request and no active turn, the daemon runs no query in a period of 60 s", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.runWithin(
      `${queuePrelude}${statementCount}
const daemon = await launched({ nextCommand: undefined });
try {
  const admitted = await submitted("idle-run");
  await until(() => existsSync("input-CLV-900"));
  writeFileSync("outcome-CLV-900", "handoff_requested");
  await until(async () => (await shown(admitted.runId)).state === "completed");
  await delay(testMilliseconds(2000));
  counting.on = true;
  await delay(${String(idleMilliseconds)});
  counting.on = false;
  print({ idleStatements: [...idleStatements].map(([sql, count]) => ({ count, sql })) });
} finally { await daemon.close(); }
process.exit(0);
`,
      testMilliseconds(45_000) + idleMilliseconds,
    );
    assert.equal(result.status, 0, result.stderr);
    const [idle] = result.lines;
    assert.deepEqual(idle, { idleStatements: [] });
  }));
