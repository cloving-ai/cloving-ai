import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { queuePrelude, queueWorkflow } from "./daemon-queue-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";
import { productRoot, withConsumer } from "./world-host-fixture.ts";

const idleMilliseconds = 60_000;

const statementCount = `
import * as idleSqlite from "node:sqlite";
const productSources = ${JSON.stringify(pathToFileURL(join(productRoot, "src")).href + "/")};
const productStatements = [];
const counting = { on: false };
Error.stackTraceLimit = 100;
const recorded = (sql) => {
  if (!counting.on) return;
  const frames = new Error().stack.split("\\n").filter((line) => line.includes(productSources));
  if (frames.length > 0) productStatements.push({ sql, frames: frames.slice(0, 3).map((line) => line.trim()) });
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

await test("CLV-284 after a finished run, with no request and no active turn, the daemon runs no query of its own in a period of 60 s", () =>
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
  print({ productStatements });
} finally { await daemon.close(); }
process.exit(0);
`,
      testMilliseconds(45_000) + idleMilliseconds,
    );
    assert.equal(result.status, 0, result.stderr);
    const [idle] = result.lines;
    assert.deepEqual(idle, { productStatements: [] });
  }));
