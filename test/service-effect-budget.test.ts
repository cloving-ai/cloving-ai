import assert from "node:assert/strict";
import { test } from "node:test";
import {
  call,
  field,
  items,
  text,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

async function createdPayload(
  harness: Harness,
  commandId: string,
): Promise<unknown> {
  const result = await call(harness, {
    operation: "run",
    parameters: {
      workflowId: "develop",
      source: "prompt",
      submission: { prompt: "the task" },
      commandId,
    },
  });
  const page = await call(harness, {
    operation: "events",
    parameters: { after: 0, limit: 10, runId: text(result, "runId") },
  });
  const created = items(field(page, "events")).find(
    (event) => field(event, "type") === "run.created",
  );
  return field(created, "payload");
}

await test("CLV-049 a run of a workflow whose registration declares an effect limit pins the limit and the canonical capabilities of its manifest", () =>
  withHarness(async (harness) => {
    await harness.start({
      workflows: [
        {
          ...harness.registration,
          effectLimit: 7,
          manifest: {
            ...harness.registration.manifest,
            capabilities: ["tracker", "fake-harness"],
          },
        },
      ],
    });
    const payload = await createdPayload(harness, "c-run");
    assert.deepEqual(
      [field(payload, "effectLimit"), field(payload, "capabilities")],
      ["7", '["fake-harness","tracker"]'],
    );
  }));

await test("CLV-049 a run of a workflow whose registration declares no effect limit has no effect budget", () =>
  withHarness(async (harness) => {
    await harness.start();
    const payload = await createdPayload(harness, "c-run");
    assert.deepEqual(
      [field(payload, "effectLimit"), field(payload, "capabilities")],
      [undefined, undefined],
    );
  }));
