import assert from "node:assert/strict";
import { test } from "node:test";
import { changedQueueLanesConfiguration } from "../src/configuration-change.ts";
import { parseConfiguration } from "../src/project-settings.ts";

await test("CLV-377 lowering lanes atomically adjusts an explicit working cap and preserves private settings", () => {
  const previous = {
    version: 1,
    merge: { mode: "queue" },
    queue: { lanes: 8, workingLanes: 6 },
    queues: {
      develop: { state: "on", everySeconds: 300, lanes: 4, workingLanes: 3 },
      triage: { lanes: 2, workingLanes: 1 },
    },
  };
  const text = changedQueueLanesConfiguration(JSON.stringify(previous), {
    scope: "private",
    queueLanes: { workflowId: "develop", lanes: 2 },
  });
  assert.deepEqual(parseConfiguration(text, "private"), {
    ...previous,
    queues: {
      ...previous.queues,
      develop: { ...previous.queues.develop, lanes: 2, workingLanes: 2 },
    },
  });
});

await test("CLV-377 increasing lanes preserves an explicit lower cap and a following default stays absent", () => {
  for (const working of [{}, { workingLanes: 1 }]) {
    const text = changedQueueLanesConfiguration(
      JSON.stringify({
        version: 1,
        queues: { develop: { lanes: 2, ...working } },
      }),
      { scope: "private", queueLanes: { workflowId: "develop", lanes: 4 } },
    );
    assert.deepEqual(parseConfiguration(text, "private").queues, {
      develop: { lanes: 4, ...working },
    });
  }
});

await test("CLV-377 a concurrent private general working-cap edit is resolved inside the lane write", () => {
  for (const cap of [1, 3]) {
    const text = changedQueueLanesConfiguration(
      JSON.stringify({ version: 1, queue: { workingLanes: cap } }),
      {
        scope: "private",
        queueLanes: { workflowId: "develop", lanes: 2 },
      },
    );
    assert.deepEqual(parseConfiguration(text, "private").queues, {
      develop: cap > 2 ? { lanes: 2, workingLanes: 2 } : { lanes: 2 },
    });
  }
});

await test("CLV-377 a newer lower private cap is preserved while a controlling environment cap keeps its precedence", () => {
  const contents = JSON.stringify({ version: 1, queue: { workingLanes: 1 } });
  for (const workingSource of ["queue setting", "environment"] as const) {
    const text = changedQueueLanesConfiguration(contents, {
      scope: "private",
      queueLanes: {
        workflowId: "develop",
        lanes: 2,
        working:
          workingSource === "environment" ? { environmentGeneral: 3 } : {},
      },
    });
    assert.deepEqual(parseConfiguration(text, "private").queues, {
      develop:
        workingSource === "environment"
          ? { lanes: 2, workingLanes: 2 }
          : { lanes: 2 },
    });
  }
});

await test("CLV-377 a private cap removed by CLI is not recreated from stale runtime state", () => {
  const text = changedQueueLanesConfiguration(
    '{"version":1,"queues":{"develop":{"lanes":4}}}',
    {
      scope: "private",
      queueLanes: { workflowId: "develop", lanes: 2 },
    },
  );
  assert.deepEqual(parseConfiguration(text, "private").queues, {
    develop: { lanes: 2 },
  });
});
