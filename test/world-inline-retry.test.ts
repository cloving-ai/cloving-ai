import assert from "node:assert/strict";
import { test } from "node:test";
import { withConsumer } from "./world-host-fixture.ts";

const workflows = `
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createHook } from "workflow";

export async function flaky(directory: string) {
  "use step";
  appendFileSync(directory + "/attempts", "attempt\\n");
  const attempts = readFileSync(directory + "/attempts", "utf8").split("\\n").length - 1;
  if (attempts > 1) return "done";
  await delay(500);
  throw new Error("the first attempt fails");
}

export async function develop(input: { directory: string; token: string }) {
  "use workflow";
  const [result] = await Promise.all([flaky(input.directory), createHook({ token: input.token })]);
  return result;
}
`;

const raced = `
import { resumeHook } from "workflow/api";
const opening = await startHost({ dataDirectory, concurrency: 4, handler: POST });
if (opening.kind !== "started") { print(opening); process.exit(0); }
const directory = process.cwd();
const token = "race-" + String(Date.now());
const run = await start(workflows.develop, [{ directory, token }]);
while (!existsSync(directory + "/attempts")) await delay(10);
await resumeHook(token, { go: true });
const outcome = await Promise.race([getRun(run.runId).returnValue, delay(20000).then(() => "hung")]);
const attempts = readFileSync(directory + "/attempts", "utf8").split("\\n").length - 1;
print({ outcome, attempts });
process.exit(0);
`;

await test("#852 a failed inline step attempt that a queued delivery of the same step waits on gets its retry, and the run completes", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(raced, {
      WORKFLOW_LOCAL_QUEUE_CONCURRENCY: "4",
      WORKFLOW_INLINE_OWNERSHIP: "0",
    });
    assert.deepEqual(result.lines, [{ outcome: "done", attempts: 2 }]);
  }));
