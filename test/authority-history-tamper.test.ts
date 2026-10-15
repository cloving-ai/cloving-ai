import assert from "node:assert/strict";
import { test } from "node:test";
import {
  restore,
  type RestoredSnapshot,
} from "../src/broker/authority-restore.ts";
import { generatedHistory } from "./authority-history-generated.ts";
import { referenceHistory } from "./authority-history-reference.ts";
import { historySnapshot } from "./authority-opening-fixture.ts";

function changed<Row>(
  rows: readonly Row[],
  change: { readonly index: number; readonly fields: Partial<Row> },
): readonly Row[] {
  return rows.map((row, index) =>
    index === change.index ? { ...row, ...change.fields } : row,
  );
}

function refused(snapshot: RestoredSnapshot, detail: string): void {
  assert.deepEqual(restore(snapshot), {
    kind: "refused",
    reason: "projection-mismatch",
    detail,
  });
}

function checkProjections(snapshot: RestoredSnapshot): void {
  snapshot.runs.forEach((_row, index) => {
    refused(
      {
        ...snapshot,
        runs: changed(snapshot.runs, { index, fields: { revision: 0 } }),
      },
      "runs",
    );
  });
  snapshot.commands.forEach((_row, index) => {
    refused(
      {
        ...snapshot,
        commands: changed(snapshot.commands, {
          index,
          fields: { request: "{}" },
        }),
      },
      "commands",
    );
  });
  (snapshot.gates ?? []).forEach((_row, index) => {
    refused(
      {
        ...snapshot,
        gates: changed(snapshot.gates ?? [], {
          index,
          fields: { revision: 0 },
        }),
      },
      "gates",
    );
  });
  (snapshot.details ?? []).forEach((_row, index) => {
    refused(
      {
        ...snapshot,
        details: changed(snapshot.details ?? [], {
          index,
          fields: { generation: 0 },
        }),
      },
      "details",
    );
  });
  refused({ ...snapshot, definitions: [] }, "definitions");
  refused(
    {
      ...snapshot,
      definitions: snapshot.definitions.map((row) => ({
        ...row,
        pin: "changed",
      })),
    },
    "definitions",
  );
}

function checkEffects(snapshot: RestoredSnapshot): void {
  const effects = snapshot.effects;
  assert.ok(effects);
  effects.budgets.forEach((_row, index) => {
    refused(
      {
        ...snapshot,
        effects: {
          ...effects,
          budgets: changed(effects.budgets, { index, fields: { spent: -1 } }),
        },
      },
      "budgets",
    );
  });
  effects.operations.forEach((_row, index) => {
    refused(
      {
        ...snapshot,
        effects: {
          ...effects,
          operations: changed(effects.operations, {
            index,
            fields: { attempts: -1 },
          }),
        },
      },
      "operations",
    );
  });
  effects.leases.forEach((_row, index) => {
    refused(
      {
        ...snapshot,
        effects: {
          ...effects,
          leases: changed(effects.leases, { index, fields: { generation: 0 } }),
        },
      },
      "leases",
    );
  });
}

await test("CLV-048 every generated projection row retains its refusal reason and detail", () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const events = generatedHistory(seed);
    const snapshot = historySnapshot({
      events,
      history: referenceHistory(events),
    });
    checkProjections(snapshot);
    checkEffects(snapshot);
  }
});

await test("CLV-048 a request mismatch at every history position retains the full replay error", () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const events = generatedHistory(seed);
    const snapshot = historySnapshot({
      events,
      history: referenceHistory(events),
    });
    events.forEach((_event, index) => {
      const invalid = changed(events, { index, fields: { request: "{}" } });
      let failure: unknown;
      try {
        referenceHistory(invalid);
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof Error);
      const detail = failure.message;
      assert.deepEqual(
        restore({
          ...snapshot,
          events: changed(snapshot.events, {
            index,
            fields: { request: "{}" },
          }),
        }),
        { kind: "refused", reason: "invalid-history", detail },
      );
    });
  }
});
