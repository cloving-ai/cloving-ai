import { record } from "../src/protocol.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { restartTrace as serviceTrace } from "../src/service/restart-trace.ts";
import { restartTrace as hostTrace } from "../tools/restart-trace.ts";

for (const [name, trace] of [
  ["service", serviceTrace],
  ["host", hostTrace],
] as const) {
  await test(`CLV-347 ${name} restart diagnostics are opt-in and contain a phase, wall time and process identity`, () => {
    const original = process.stderr.write.bind(process.stderr);
    const previous = process.env["CLOVING_RESTART_TRACE"];
    const lines: string[] = [];
    process.stderr.write = (chunk) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      delete process.env["CLOVING_RESTART_TRACE"];
      trace("hidden");
      assert.deepEqual(lines, []);
      process.env["CLOVING_RESTART_TRACE"] = "1";
      const before = Date.now();
      trace("requested");
      assert.equal(lines.length, 1);
      const entry = record(JSON.parse(lines.join("")));
      const at = entry?.["at"];
      assert.equal(typeof at, "number");
      assert.deepEqual(entry, {
        phase: "requested",
        at,
        processId: process.pid,
      });
      assert.ok(Number(at) >= before && Number(at) <= Date.now());
    } finally {
      process.stderr.write = original;
      if (previous === undefined) delete process.env["CLOVING_RESTART_TRACE"];
      else process.env["CLOVING_RESTART_TRACE"] = previous;
    }
  });
}
