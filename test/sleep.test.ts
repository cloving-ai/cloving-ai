import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

await test("CLV-233 sleep awaits SDK millisecond durations and propagates timer failures", () => {
  const helper = new URL("../src/steps/sleep.ts", import.meta.url).href;
  const script = `
import assert from "node:assert/strict";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
const durations = [];
let timer;
mock.module("workflow", { namedExports: { sleep(milliseconds) {
  durations.push(milliseconds);
  return timer.promise;
} } });
const { sleep } = await import(${JSON.stringify(helper)});
for (const seconds of [1, 86400]) {
  timer = Promise.withResolvers();
  let settled = false;
  const waiting = sleep({ seconds }).then(() => { settled = true; });
  await setImmediate();
  assert.equal(settled, false);
  assert.equal(durations.at(-1), seconds * 1000);
  timer.resolve();
  assert.equal(await waiting, undefined);
  assert.equal(settled, true);
}
timer = Promise.withResolvers();
const waiting = sleep({ seconds: 60 });
const failure = new Error("timer-failed");
timer.reject(failure);
await assert.rejects(waiting, (error) => error === failure);
assert.deepEqual(durations, [1000, 86400000, 60000]);
mock.restoreAll();
`;
  const output = execFileSync(
    process.execPath,
    ["--experimental-test-module-mocks", "--input-type=module", "-e", script],
    { encoding: "utf8", stdio: "pipe" },
  );
  assert.equal(output, "");
});

await test("CLV-233 invalid sleep data rejects before invoking the SDK or a protected effect", () => {
  const helper = new URL("../src/steps/sleep.ts", import.meta.url).href;
  const script = `
import assert from "node:assert/strict";
import { mock } from "node:test";
let waits = 0;
mock.module("workflow", { namedExports: { sleep: async () => { waits += 1; } } });
const { sleep } = await import(${JSON.stringify(helper)});
const invalid = [undefined, null, {}, [], 1, "1", true,
  ...[0, -1, 0.5, NaN, Infinity, -Infinity, 86401, "1", null, true].map(seconds => ({ seconds })),
  { seconds: 1, callback() {} }, { seconds: 1, [Symbol("handle")]: 1 },
  { get seconds() { throw new Error("live-getter"); } },
];
for (const request of invalid)
  await assert.rejects(sleep(request), { message: "invalid-sleep-seconds" });
assert.equal(waits, 0);
mock.restoreAll();
`;
  const output = execFileSync(
    process.execPath,
    ["--experimental-test-module-mocks", "--input-type=module", "-e", script],
    { encoding: "utf8", stdio: "pipe" },
  );
  assert.equal(output, "");
});
