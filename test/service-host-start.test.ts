import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ServiceOptions } from "../src/service/service.ts";
import { withHarness } from "./service-fixture.ts";

function recordedHost(
  calls: string[],
  name: string,
): NonNullable<ServiceOptions["host"]> {
  return () => {
    calls.push(`${name} started`);
    return Promise.resolve({
      close: () => {
        calls.push(`${name} closed`);
        return Promise.resolve();
      },
    });
  };
}

await test("CLV-055 a second service on the same state directory is refused before its host starts the World", () =>
  withHarness(async (harness) => {
    const calls: string[] = [];
    const service = await harness.start({ host: recordedHost(calls, "first") });
    assert.deepEqual(calls, ["first started"]);
    const sameDirectories = await harness.attempt({
      host: recordedHost(calls, "second"),
    });
    assert.partialDeepStrictEqual(sameDirectories, {
      kind: "refused",
      reason: "service-already-running",
    });
    const otherRuntime = await harness.attempt({
      host: recordedHost(calls, "third"),
      runtimeDirectory: mkdtempSync(join(harness.stateDirectory, "runtime-")),
    });
    assert.partialDeepStrictEqual(otherRuntime, {
      kind: "refused",
      reason: "authority-held",
    });
    assert.deepEqual(calls, ["first started"]);
    await service.close();
    assert.deepEqual(calls, ["first started", "first closed"]);
  }));

await test("CLV-055 a service whose host does not start is refused and does not hold the authority", () =>
  withHarness(async (harness) => {
    const refused = await harness.attempt({
      host: () => Promise.reject(new Error("host-bound")),
    });
    assert.deepEqual(refused, {
      kind: "refused",
      reason: "host-unavailable",
      detail: "host-bound",
    });
    const calls: string[] = [];
    const service = await harness.start({ host: recordedHost(calls, "next") });
    await service.close();
    assert.deepEqual(calls, ["next started", "next closed"]);
  }));
