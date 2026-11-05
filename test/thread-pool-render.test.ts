import assert from "node:assert/strict";
import { test } from "node:test";
import { rendered } from "../src/cli/render.ts";

function runList(threadPool: unknown): string {
  return rendered({
    schemaVersion: 1,
    kind: "run-list",
    workflows: [],
    runs: [],
    next: null,
    threadPool,
  });
}

await test("CLV-298 cloving status shows a stalled pool check of the daemon with its time, elapsed time and resource counts", () => {
  const text = runList({
    result: "stalled",
    checkedAt: "2026-11-05T10:00:00.000Z",
    milliseconds: 5003,
    resources: { FSReqPromise: 3, "Time\u001bout": 2 },
  });
  assert.match(
    text,
    /^Thread pool: stalled; the check at 2026-11-05T10:00:00\.000Z had no answer after 5003 ms; resources FSReqPromise:3,Time\\u001bout:2$/m,
  );
  assert.equal(text.split("\n")[0], "Workflows: none");
});

await test("CLV-298 cloving status shows no pool line for an ok pool check or for no check", () => {
  for (const threadPool of [
    undefined,
    { result: "ok", checkedAt: "2026-11-05T10:00:00.000Z", milliseconds: 2 },
  ])
    assert.doesNotMatch(runList(threadPool), /Thread pool/);
});

await test("CLV-298 cloving status shows none for a stalled pool check with no resource counts", () => {
  assert.match(
    runList({
      result: "stalled",
      checkedAt: "2026-11-05T10:00:00.000Z",
      milliseconds: 5003,
    }),
    /^Thread pool: stalled; the check at 2026-11-05T10:00:00\.000Z had no answer after 5003 ms; resources none$/m,
  );
});
