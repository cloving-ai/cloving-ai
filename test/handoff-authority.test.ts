import assert from "node:assert/strict";
import { test } from "node:test";
import { admitted } from "../src/broker/authority-admission.ts";
import { effectInputDigest } from "../src/broker/effect-restore.ts";
import { admit, lastState, run } from "./authority-fixture.ts";
import { manifest } from "./authority-store-fixture.ts";
import { request } from "./effect-pure-fixture.ts";

const state = lastState(run([admit]));
const effect = {
  capability: "handoff",
  method: "run",
  target: "B",
  payload: `sha256:${"a".repeat(64)}`,
};

function admission(
  handoffs: readonly string[],
  extra: Readonly<Record<string, unknown>> = {},
) {
  const fields = { ...effect, ...extra };
  return admitted(state, {
    definitions: new Map([["pin-1", { ...manifest, handoffs }]]),
    command: {
      ...request(1),
      units: 1,
      ...fields,
      inputDigest: effectInputDigest({ ...effect, ...extra }),
    },
    manifest: undefined,
  });
}

await test("CLV-182 handoff authority uses the run's own pinned target list", () => {
  for (const handoffs of [[], ["C"]])
    assert.deepEqual(admission(handoffs), {
      kind: "rejected",
      reason: "handoff-not-declared",
    });
  assert.equal(admission(["B"]).kind, "admissible");
  assert.deepEqual(admission(["B"], { runId: "other-run" }), {
    kind: "rejected",
    reason: "handoff-not-declared",
  });
});

await test("CLV-182 a handoff always requests one unit and the run method", () => {
  for (const extra of [{ units: 0 }, { units: 2 }, { method: "other" }])
    assert.deepEqual(admission(["B"], extra), {
      kind: "rejected",
      reason: "invalid-handoff-request",
    });
});
