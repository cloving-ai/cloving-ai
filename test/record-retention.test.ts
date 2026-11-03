import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunStatus } from "../src/authority/transitions.ts";
import { retentionVerdict, type StoredRun } from "../src/record-retention.ts";

const day = 86_400_000;
const now = Date.parse("2026-11-02T00:00:00.000Z");

const operationId = JSON.stringify([
  "cloving-operation",
  0,
  "run-1",
  "develop",
  "turn",
  null,
  null,
]);

function ago(days: number): number {
  return now - days * day;
}

function verdict(scene: {
  readonly started: unknown;
  readonly run?: StoredRun;
  readonly changedDaysAgo: number;
}) {
  return retentionVerdict(
    { started: scene.started, changedAt: ago(scene.changedDaysAgo) },
    {
      runs: scene.run === undefined ? {} : { "run-1": scene.run },
      now,
      days: 30,
    },
  );
}

function finished(status: RunStatus, endedDaysAgo: number): StoredRun {
  return { status, endedAt: ago(endedDaysAgo) };
}

for (const status of ["running", "queued", "waiting_gate", "paused"] as const)
  await test(`CLV-270 the folder of a ${status} run stays at any age`, () => {
    assert.equal(
      verdict({
        started: { runId: "run-1" },
        run: { status, endedAt: null },
        changedDaysAgo: 500,
      }),
      "skipped",
    );
  });

for (const status of ["completed", "failed", "cancelled"] as const)
  await test(`CLV-270 the folder of a ${status} run is due when its end and its newest file are older than the period`, () => {
    assert.equal(
      verdict({
        started: { runId: "run-1" },
        run: finished(status, 40),
        changedDaysAgo: 31,
      }),
      "due",
    );
  });

await test("CLV-270 a folder with a file that changed in the period stays", () => {
  assert.equal(
    verdict({
      started: { runId: "run-1" },
      run: finished("completed", 40),
      changedDaysAgo: 10,
    }),
    "kept",
  );
});

await test("CLV-270 a folder of a run that ended in the period stays", () => {
  assert.equal(
    verdict({
      started: { runId: "run-1" },
      run: finished("completed", 10),
      changedDaysAgo: 40,
    }),
    "kept",
  );
});

await test("CLV-270 a folder of a finished run with no known end stays", () => {
  assert.equal(
    verdict({
      started: { runId: "run-1" },
      run: { status: "cancelled", endedAt: null },
      changedDaysAgo: 40,
    }),
    "kept",
  );
});

await test("CLV-270 a folder exactly at the end of the period stays", () => {
  assert.equal(
    verdict({
      started: { runId: "run-1" },
      run: finished("completed", 30),
      changedDaysAgo: 30,
    }),
    "kept",
  );
});

for (const [name, started] of [
  ["the third element of the operation ID", { operationId }],
  [
    "the operation ID when the run ID is not a string",
    { runId: 7, operationId },
  ],
] as const)
  await test(`CLV-270 the run ID comes from ${name}`, () => {
    assert.equal(
      verdict({ started, run: finished("completed", 40), changedDaysAgo: 40 }),
      "due",
    );
  });

for (const [name, started] of [
  ["a started record that cannot be read", undefined],
  ["a started record that is null", null],
  ["a started record that is a string", "run-1"],
  ["a started record with no run ID", { operationId: "not-an-operation" }],
  ["a started record of an unknown run", { runId: "run-2" }],
  ["a started record that names a member of Object", { runId: "toString" }],
] as const)
  await test(`CLV-270 the folder of ${name} stays as unreadable`, () => {
    assert.equal(
      verdict({ started, run: finished("completed", 40), changedDaysAgo: 40 }),
      "unreadable",
    );
  });
