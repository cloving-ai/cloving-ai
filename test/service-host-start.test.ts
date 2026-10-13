import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ServiceOptions } from "../src/service/service.ts";
import { withHarness, type Harness } from "./service-fixture.ts";

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

function stuckHost(calls: string[]): NonNullable<ServiceOptions["host"]> {
  return () => {
    calls.push("host started");
    return Promise.resolve({
      close: () => {
        calls.push("host close called");
        return Promise.reject(new Error("the World does not close"));
      },
    });
  };
}

function lockedRuntime(
  harness: Harness,
  host: NonNullable<ServiceOptions["host"]>,
): Pick<ServiceOptions, "host" | "runtimeDirectory"> {
  const runtimeDirectory = join(harness.stateDirectory, "..", "locked");
  mkdirSync(runtimeDirectory, { mode: 0o700 });
  harness.cleanup(() => {
    chmodSync(runtimeDirectory, 0o700);
  });
  return {
    runtimeDirectory,
    host: async (ports) => {
      const started = await host(ports);
      chmodSync(runtimeDirectory, 0o500);
      return started;
    },
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

await test("CLV-055 a close of the host that rejects closes the authority, and the close of the service rejects with the error of the host", () =>
  withHarness(async (harness) => {
    const calls: string[] = [];
    const service = await harness.start({ host: stuckHost(calls) });
    await assert.rejects(service.close(), {
      message: "the World does not close",
    });
    assert.deepEqual(calls, ["host started", "host close called"]);
    const next = await harness.attempt({});
    assert.partialDeepStrictEqual(next, { kind: "started" });
  }));

await test("CLV-055 a transport failure after the host started closes the host and releases the authority", () =>
  withHarness(async (harness) => {
    const calls: string[] = [];
    const opening = await harness.attempt(
      lockedRuntime(harness, recordedHost(calls, "host")),
    );
    assert.partialDeepStrictEqual(opening, {
      kind: "refused",
      reason: "transport-failure",
    });
    assert.deepEqual(calls, ["host started", "host closed"]);
    const next = await harness.attempt({});
    assert.partialDeepStrictEqual(next, { kind: "started" });
  }));

await test("CLV-055 a transport failure with a host that does not close gives a refusal with the two causes and releases the authority", () =>
  withHarness(async (harness) => {
    const calls: string[] = [];
    const opening = await harness.attempt(
      lockedRuntime(harness, stuckHost(calls)),
    );
    assert.partialDeepStrictEqual(opening, {
      kind: "refused",
      reason: "transport-failure",
    });
    assert.match(
      String(Reflect.get(opening, "detail")),
      /^listen .*; the close failed: the World does not close$/,
    );
    assert.deepEqual(calls, ["host started", "host close called"]);
    const next = await harness.attempt({});
    assert.partialDeepStrictEqual(next, { kind: "started" });
  }));
