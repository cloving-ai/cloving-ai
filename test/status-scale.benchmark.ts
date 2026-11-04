import assert from "node:assert/strict";
import { test } from "node:test";
import { scaleDatabase } from "./authority-opening-fixture.ts";
import { call, items, withHarness } from "./service-fixture.ts";

await test("CLV-276 the first status page of 700 runs and 7000 events answers in less than 200 ms", () =>
  withHarness(async (harness) => {
    await scaleDatabase(harness.stateDirectory, 7_000);
    await harness.start();
    const started = performance.now();
    const page = await call(harness, { operation: "status", parameters: {} });
    const elapsed = performance.now() - started;
    process.stdout.write(
      `${JSON.stringify({ runs: 700, events: 7_000, milliseconds: elapsed })}\n`,
    );
    assert.equal(items(page["runs"]).length, 50);
    assert.ok(elapsed < 200, `the first page took ${String(elapsed)} ms`);
  }));
