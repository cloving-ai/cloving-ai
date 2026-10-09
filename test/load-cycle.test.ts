import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCycle } from "../src/steps/load-cycle.ts";

await test("CLV-005 loadCycle outside the Cloving host reports the missing host without effects", async () => {
  assert.deepEqual(await loadCycle({ cycleId: "cycle-1" }), {
    kind: "unavailable",
    reason: "cloving-host-unavailable",
    cycleId: "cycle-1",
  });
});

await test("CLV-005 loadCycle rejects a malformed cycle input before any host access", async () => {
  assert.deepEqual(await loadCycle({ cycleId: "has space" }), {
    kind: "invalid",
    reason: "invalid-development-input",
  });
});
