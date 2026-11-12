import assert from "node:assert/strict";
import { test } from "node:test";
import { parsed, withHarness } from "./service-fixture.ts";
import { fakeService } from "./watch-service-fixture.ts";
import type { ServiceRequest } from "../src/protocol.ts";

await test("CLV-361 queue lanes reports an unavailable queue before attempting a write", () =>
  withHarness(async (harness) => {
    await harness.start();
    const reply = await harness.cli([
      "queue",
      "lanes",
      "3",
      "--workflow",
      "develop",
      "--json",
    ]);
    assert.equal(reply.status, 1);
    assert.equal(parsed(reply)["code"], "queue-unavailable");
  }));

await test("CLV-361 queue lanes refuses a service reply without a lane count and sends no mutation", () =>
  withHarness(async (harness) => {
    const requests: ServiceRequest[] = [];
    const close = await fakeService(harness.runtimeDirectory, (request) => {
      requests.push(request);
      return { kind: "result", result: { queue: { workflowId: "develop" } } };
    });
    try {
      const reply = await harness.cli([
        "queue",
        "lanes",
        "3",
        "--workflow",
        "develop",
        "--json",
      ]);
      assert.equal(reply.status, 1);
      assert.equal(parsed(reply)["code"], "queue-unavailable");
      assert.match(String(parsed(reply)["detail"]), /no queue lane count/);
      assert.deepEqual(
        requests.map((request) => request.operation),
        ["queue"],
      );
    } finally {
      await close();
    }
  }));
