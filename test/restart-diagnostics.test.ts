import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diagnosedRestartScene,
  replacementPhases,
} from "./restart-diagnostics-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

await test("CLV-347 failed restart scenes retain host phases, raw CLI timing/output and restart claim before cleanup", () =>
  withFiles(
    {
      "restart-cli.json":
        '{"started":1,"ended":2,"status":130,"stdout":"RAW_RESTART","stderr":"PENDING"}',
      "claimed-restart": "CLAIMED_REQUEST",
    },
    async (directory) => {
      const scene = {
        fixture: { directory },
        output: () => "HOST_PHASES",
      };
      await assert.rejects(
        diagnosedRestartScene(scene, () => {
          throw new Error("ORIGINAL_FAILURE");
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          for (const text of [
            "ORIGINAL_FAILURE",
            "HOST_PHASES",
            "RAW_RESTART",
            "PENDING",
            "CLAIMED_REQUEST",
          ])
            assert.ok(error.message.includes(text), error.message);
          return true;
        },
      );
    },
  ));

await test("CLV-347 restart proof waits for forwarded replacement identity, readiness and compiler phases and rejects late initial traces", async () => {
  const requested = 1000;
  const initial = [
    { phase: "service-identity", at: 100, processId: 1 },
    { phase: "listener-ready", at: 200, processId: 1 },
  ];
  const identity = { phase: "service-identity", at: 1010, processId: 2 };
  const ready = { phase: "listener-ready", at: 1020, processId: 2 };
  const snapshots = [
    initial,
    [...initial, identity],
    [
      ...initial,
      identity,
      ready,
      { phase: "recovery-end", at: 1030, processId: 2 },
    ],
    [
      ...initial,
      identity,
      ready,
      { phase: "recovery-end", at: 1030, processId: 2 },
      { phase: "compiler-end", at: 1005, processId: 3 },
    ],
  ];
  const reads = { count: 0 };
  const proof = await replacementPhases({
    requested,
    startedAt: identity.at,
    required: ["compiler-end"],
    output: () => {
      const snapshot =
        snapshots[Math.min(reads.count, snapshots.length - 1)] ?? [];
      reads.count += 1;
      return snapshot.map((entry) => JSON.stringify(entry)).join("\n");
    },
  });
  assert.deepEqual(proof.ready, ready);
  assert.ok(reads.count >= 4);
  assert.equal(
    proof.phases.some((entry) => entry.processId === 1),
    false,
  );
});
