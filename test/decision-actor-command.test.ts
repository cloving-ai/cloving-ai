import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "../src/authority/commands.ts";

const decision = {
  kind: "decide-gate",
  commandId: "phone-1",
  runId: "run-1",
  gateId: "design-1",
  decision: "approved",
  expectedRevision: 1,
  generation: 1,
  subject: `sha256:${"a".repeat(64)}`,
};

await test("CLV-186 a decide-gate command keeps a device actor and refuses every other actor form", () => {
  assert.equal(
    parseCommand({ ...decision, actor: "device:pixel8a" })?.actor,
    "device:pixel8a",
  );
  assert.equal(parseCommand(decision)?.actor, undefined);
  for (const actor of [
    "device:",
    "device:a b",
    "phone:x",
    "operator",
    `device:${"a".repeat(65)}`,
    7,
  ])
    assert.equal(
      parseCommand({ ...decision, actor }),
      null,
      JSON.stringify(actor),
    );
  assert.equal(
    parseCommand({
      kind: "expire-gate",
      commandId: "c-2",
      runId: "run-1",
      gateId: "design-1",
      actor: "device:pixel8a",
    }),
    null,
  );
});
