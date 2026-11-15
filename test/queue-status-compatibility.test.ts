import assert from "node:assert/strict";
import { test } from "node:test";
import { call, field, items, parsed, withHarness } from "./service-fixture.ts";

await test("CLV-373 v1.9 status omits an inactive declared queue and the unqualified CLI reports unavailable", () =>
  withHarness(async (harness) => {
    await harness.start({
      workflows: [
        {
          ...harness.registration,
          manifest: { ...harness.registration.manifest, queue: true },
        },
      ],
    });
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.equal(status["queue"], undefined);
    assert.equal(field(items(status["queues"])[0], "state"), "off");
    const json = await harness.cli(["status", "--json"]);
    assert.equal(parsed(json)["queue"], undefined);
    const text = await harness.cli(["status"]);
    assert.doesNotMatch(text.stdout, /Queue:/);
    const queue = await harness.cli(["queue", "--json"]);
    assert.equal(queue.status, 1);
    assert.equal(parsed(queue)["code"], "queue-unavailable");
    const explicit = await harness.cli([
      "queue",
      "--workflow",
      "develop",
      "--json",
    ]);
    assert.equal(explicit.status, 0, explicit.stdout);
    assert.equal(field(parsed(explicit)["queue"], "state"), "off");
  }));

await test("CLV-373 v1.9 status and unqualified queue CLI keep the admitted queue fields without a loop", () =>
  withHarness(async (harness) => {
    await harness.start({
      workflows: [{ ...harness.registration, admission: 2 }],
    });
    const expected = {
      workflowId: "develop",
      lanes: 2,
      busy: 0,
      busyRunIds: [],
      skipped: [],
    };
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(status["queue"], expected);
    assert.equal(field(items(status["queues"])[0], "state"), "off");
    const json = await harness.cli(["queue", "--json"]);
    assert.deepEqual(parsed(json)["queue"], expected);
    const text = await harness.cli(["queue"]);
    assert.equal(text.status, 0, text.stderr);
    assert.equal(text.stdout, "Queue: 0 of 2 lanes busy\n");
  }));
