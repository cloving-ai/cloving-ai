import assert from "node:assert/strict";
import { test } from "node:test";
import { instantMilliseconds } from "../src/authority/instants.ts";

for (const value of [
  "0000-01-01T00:00:00Z",
  "0000-02-29T23:59:59.001Z",
  "0099-12-31T23:59:59.999Z",
  "0100-03-01T00:00:00Z",
  "0400-02-29T12:00:00Z",
  "1600-03-01T00:00:00Z",
  "1900-02-28T23:59:59.999Z",
  "1900-03-01T00:00:00Z",
  "1969-12-31T23:59:59.999Z",
  "1970-01-01T00:00:00Z",
  "1970-01-01T00:00:00.001Z",
  "2000-02-29T12:34:56.789Z",
  "2026-10-28T14:00:00.137Z",
  "2100-03-01T00:00:00Z",
  "2400-02-29T00:00:00Z",
  "9999-12-31T23:59:59.999Z",
])
  await test(`CLV-235 pure instant conversion preserves calendar and milliseconds for ${value}`, () => {
    assert.equal(instantMilliseconds(value), Date.parse(value));
  });

for (const value of [
  "invalid",
  "2026-02-29T00:00:00Z",
  "1900-02-29T00:00:00Z",
  "2026-01-01T00:00:00+01:00",
  "2026-01-01T00:00:00.1Z",
])
  await test(`CLV-235 pure instant conversion refuses invalid authority time ${value}`, () => {
    assert.throws(() => instantMilliseconds(value), /invalid-instant/);
  });
