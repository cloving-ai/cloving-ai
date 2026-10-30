import assert from "node:assert/strict";
import { test } from "node:test";
import {
  declaredQueuePrelude as queuePrelude,
  queueWorkflow,
} from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

await test("CLV-184 two lanes admit two ready tickets while both remain active", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
writeFileSync("ready", "CLV-900");
const daemon = await launched({ queueLanes: 2 });
try {
  await until(() => existsSync("input-CLV-900"));
  writeFileSync("ready", "CLV-901");
  await until(async () => (await runs()).length === 2);
  await delay(400);
  assert.equal((await runs()).length, 2);
  assert.equal(commands().length, 2);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-184 four lanes exclude active tickets and reject duplicate manual admissions", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
writeFileSync("next.mjs", \`import { appendFileSync } from "node:fs";
const skipped = process.env.CLOVING_SKIP_TICKETS ?? "";
appendFileSync("skips", JSON.stringify(skipped) + "\\\\n");
const ticket = ["900", "901", "902", "903", "904"].find(id => !skipped.split(" ").includes(id));
if (ticket) process.stdout.write(ticket);\`);
const daemon = await launched({ queueLanes: 4, queueMilliseconds: 100 });
try {
  await until(() => existsSync("input-900"));
  assert.equal((await submitted("duplicate", { submission: { ticket: "900" } })).code, "ticket-active");
  await until(async () => (await runs()).length === 4);
  await delay(350);
  assert.equal((await runs()).length, 4);
  assert.equal((await submitted("full", { submission: { ticket: "904" } })).code, "workflow-active");
  const skipped = readFileSync("skips", "utf8").trim().split("\\n").map(JSON.parse);
  assert.deepEqual(skipped, ["", "900", "900 901", "900 901 902"]);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));

await test("CLV-184 dependency waits skip a ticket until its dependency closes", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
writeFileSync("next.mjs", \`import { appendFileSync } from "node:fs";
const skipped = process.env.CLOVING_SKIP_TICKETS ?? "";
appendFileSync("skips", skipped + "\\\\n");
const ticket = ["900", "901"].find(id => !skipped.split(" ").includes(id));
if (ticket) process.stdout.write(ticket);\`);
writeFileSync("ticket.mjs", 'const id = process.argv.at(-1); process.stdout.write("# Task " + id + "\\\\nGitHub issue: example/project#" + id + (id === "900" ? "\\\\n## Dependencies\\\\nNeeds #899.\\\\n## Notes\\\\nNeeds #898." : ""));');
writeFileSync("gh.mjs", 'import { existsSync } from "node:fs"; process.stdout.write(JSON.stringify({ state: existsSync("closed") ? "closed" : "open" }));');
const daemon = await launched({ queueLanes: 2, githubCommand: [process.execPath, directory + "/gh.mjs"] });
try {
  const refused = await submitted("dependency", { submission: { ticket: "900" } });
  assert.equal(refused.code, "ticket-dependency-open");
  assert.match(refused.detail, /899/);
  await until(() => existsSync("input-901"));
  assert.equal(existsSync("input-900"), false);
  assert.ok(readFileSync("skips", "utf8").split("\\n").some(line => line.split(" ").includes("900")));
  writeFileSync("closed", "");
  await until(async () => (await runs()).length === 2);
  assert.equal((await runs()).length, 2);
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Queue stopped:/);
  }));

await test("CLV-184 transient dependency command failures retry without stopping intake", async () => {
  for (const failure of ["lookup", "refresh-lookup", "refresh-ticket"]) {
    await withConsumer(queueWorkflow, async (consumer) => {
      const result = await consumer.run(`${queuePrelude}
const failure = ${JSON.stringify(failure)};
writeFileSync("pending-self-update", String(Date.now()));
writeFileSync("next.mjs", 'const skipped = (process.env.CLOVING_SKIP_TICKETS ?? "").split(" "); process.stdout.write(["900", "901"].find(id => !skipped.includes(id)) ?? "");');
writeFileSync("ticket.mjs", \`import { existsSync, unlinkSync } from "node:fs";
if (existsSync("fail-ticket")) { unlinkSync("fail-ticket"); process.exit(1); }
const id = process.argv.at(-1);
process.stdout.write("# Task " + id + (id === "900" ? "\\\\n## Dependencies\\\\nNeeds #899." : ""));\`);
writeFileSync("gh.mjs", \`import { existsSync, unlinkSync } from "node:fs";
if (existsSync("fail-lookup")) { unlinkSync("fail-lookup"); process.exit(1); }
process.stdout.write(JSON.stringify({ state: "open" }));\`);
const daemon = await launched({ queueLanes: 2, githubCommand: [process.execPath, directory + "/gh.mjs"] });
try {
  if (failure !== "lookup")
    assert.equal((await submitted("waiting", { submission: { ticket: "900" } })).code, "ticket-dependency-open");
  writeFileSync(failure === "refresh-ticket" ? "fail-ticket" : "fail-lookup", "");
  rmSync("pending-self-update");
  await until(() => existsSync("input-901"));
  assert.equal(existsSync("input-900"), false);
  assert.equal((await runs()).length, 1);
} finally { await daemon.close(); }
process.exit(0);
`);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /Queue ticket-not-available:.*will retry/);
      assert.doesNotMatch(result.stderr, /Queue stopped:/);
    });
  }
});
