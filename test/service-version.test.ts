import assert from "node:assert/strict";
import { test } from "node:test";
import { call, field, withHarness } from "./service-fixture.ts";

await test("status names the version of the running service", () =>
  withHarness(async (harness) => {
    await harness.start({ version: "9.8.7" });
    const list = await call(harness, { operation: "status", parameters: {} });
    assert.equal(field(list, "serviceVersion"), "9.8.7");
  }));

await test("status names no version when the service starts without one", () =>
  withHarness(async (harness) => {
    await harness.start();
    const list = await call(harness, { operation: "status", parameters: {} });
    assert.equal(field(list, "serviceVersion"), undefined);
  }));
