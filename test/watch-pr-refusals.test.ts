import assert from "node:assert/strict";
import { test } from "node:test";
import { prObserver } from "../src/cli/watch-pr-observer.ts";
import {
  prOutput,
  prRepositoryFixture,
  recordedPr,
  settleObservation,
} from "./watch-pr-fixture.ts";

await test("CLV-093 missing configuration and conflicting requests cause no command", async () => {
  let calls = 0;
  for (const [failure, configuration] of [
    ["configuration", { repository: null, command: ["fake-gh"] }],
    ["configuration", { repository: prRepositoryFixture, command: null }],
    ["configuration", { repository: prRepositoryFixture, command: [] }],
    [
      "identity",
      {
        repository: { ...prRepositoryFixture, host: "other.example" },
        command: ["fake-gh"],
      },
    ],
    [
      "identity",
      {
        repository: { ...prRepositoryFixture, repository: "other" },
        command: ["fake-gh"],
      },
    ],
  ] as const) {
    const observer = prObserver({
      ...configuration,
      directory: "fixture",
      execute: () => {
        calls += 1;
        return Promise.resolve(prOutput(true));
      },
    });
    try {
      assert.deepEqual(observer.observe(recordedPr), {
        status: "unavailable",
        failure,
      });
    } finally {
      observer.close();
    }
  }
  await settleObservation();
  assert.equal(calls, 0);
});
