import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { lineLogger } from "../src/broker/actor/authority-logger.ts";
import { intentDigest } from "../src/broker/actor/delivery-intents.ts";
import { decisionState, storedGate } from "../src/broker/decision-restore.ts";
import { socketAddress } from "../src/broker/socket-address.ts";
import { send } from "../src/cli/client.ts";
import { expiryScan } from "../src/service/expiry.ts";
import { commandGateway } from "../src/service/gateway.ts";
import { workflowRegistry } from "../src/service/registry.ts";
import { checkResolution } from "../src/submission.ts";
import { failed, rejection } from "../src/service/replies.ts";
import { submissionHandler } from "../src/service/submission-handler.ts";
import { listen } from "../src/service/transport.ts";
import { openedAuthority } from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import { fakeRegistration, field, withHarness } from "./service-fixture.ts";

after(removeTemporaryDirectories);

await test("CLV-008 the library logger writes one JSON line for each level and a fixed line for an entry that it cannot convert", () => {
  const lines: string[] = [];
  const logger = lineLogger((line) => lines.push(line));
  logger.debug({ event: "a" });
  logger.info({ event: "b" });
  logger.warn({ event: "c" });
  logger.error({ event: "d", count: 1n });
  assert.deepEqual(lines, [
    '{"level":"debug","event":"a"}\n',
    '{"level":"info","event":"b"}\n',
    '{"level":"warn","event":"c"}\n',
    '{"level":"error","event":"unserializable-log-entry"}\n',
  ]);
});

const row = {
  runId: "run-1",
  gateId: "design-1",
  kind: "question",
  label: 1,
  subject: null,
  prompt: null,
  expiresAt: null,
  generation: 1,
  revision: 1,
  wait: "pending",
  decision: null,
  answer: null,
  decidedSequence: null,
  openedSequence: 3,
  continuation: null,
};

await test("CLV-008 a stored gate row with an unknown kind or wait value is refused", () => {
  assert.equal(storedGate(row).outcome, null);
  assert.throws(() => storedGate({ ...row, kind: "vote" }), /invalid-gate-row/);
  assert.throws(
    () => storedGate({ ...row, wait: "later" }),
    /invalid-gate-row/,
  );
});

await test("CLV-008 a failed or unexpected receipt becomes an error reply with the identity of the command", () => {
  assert.deepEqual(
    rejection(
      { kind: "failed", reason: "storage-unavailable", detail: "closed" },
      { commandId: "c-1" },
    ),
    {
      kind: "error",
      error: {
        commandId: "c-1",
        code: "authority-unavailable",
        detail: "storage-unavailable: closed",
      },
    },
  );
  assert.deepEqual(
    rejection({ kind: "rejected", reason: "unknown-gate" }, { runId: "run-1" }),
    {
      kind: "error",
      error: {
        runId: "run-1",
        code: "unknown-decision",
        detail: "unknown-gate",
      },
    },
  );
  assert.deepEqual(
    rejection({ kind: "accepted", sequence: 1, intents: [] }, {}),
    {
      kind: "error",
      error: { code: "invalid-request", detail: "invalid-request" },
    },
  );
  assert.deepEqual(failed("event-gap", { after: 3 }), {
    kind: "error",
    error: { after: 3, code: "event-gap", detail: "event-gap" },
  });
});

await test("CLV-008 the expiry scan continues while the authority is not available, and it stops on request", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  const registry = workflowRegistry([]);
  const clock = (): string => "2026-10-10T12:00:00.000Z";
  const scan = expiryScan({
    authority,
    gateway: commandGateway({ authority, registry, clock, textBytes: 1000 }),
    clock,
    intervalMilliseconds: 1,
  });
  await delay(60);
  await authority.close();
  await delay(30);
  await scan.stop();
  await assert.rejects(authority.state(), /authority-unavailable/);
});

await test("CLV-008 the client refuses a socket path that is too long, and the transport turns a failed handler into an error reply", () =>
  withHarness(async (harness) => {
    const deep = join(harness.runtimeDirectory, "d".repeat(60), "e".repeat(60));
    await mkdir(deep, { recursive: true });
    const refused = await send(deep, { operation: "status", parameters: {} });
    assert.equal(
      field(field(refused, "error"), "code"),
      "runtime-path-too-long",
    );
    const address = socketAddress(
      join(harness.runtimeDirectory, "control.sock"),
    );
    assert.equal(address.kind, "address");
    const listener = await listen({
      path: address.path,
      handle: () => Promise.reject(new Error("the handler failed")),
    });
    assert.deepEqual(
      await send(harness.runtimeDirectory, {
        operation: "status",
        parameters: {},
      }),
      {
        kind: "error",
        error: { code: "authority-unavailable", detail: "the handler failed" },
      },
    );
    await listener.close();
    const throwing = await listen({
      path: address.path,
      handle: () => {
        throw new Error("the handler threw");
      },
    });
    assert.deepEqual(
      await send(harness.runtimeDirectory, {
        operation: "status",
        parameters: {},
      }),
      {
        kind: "error",
        error: { code: "authority-unavailable", detail: "the handler threw" },
      },
    );
    await throwing.close();
  }));

await test("CLV-008 the input digest of a continuation binds its gate, its decision and its answer", () => {
  const base = {
    kind: "continue-run",
    runId: "run-1",
    operationId: "operation-1",
    workflow: "pin-1",
    gateId: "design-1",
    decision: "answered",
    answer: "sha256:a",
  } as const;
  const digests = [
    base,
    { ...base, gateId: "design-2" },
    { ...base, decision: "approved" },
    { ...base, answer: "sha256:b" },
    { ...base, answer: null },
  ].map(intentDigest);
  assert.equal(new Set(digests).size, 5);
  assert.equal(intentDigest({ ...base }), digests[0]);
});

await test("CLV-008 a submission that the authority rejects, or that leaves no receipt, is not reported as admitted", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  const registry = workflowRegistry([fakeRegistration([])]);
  const parameters = {
    workflowId: "develop",
    source: "prompt",
    submission: { prompt: "task" },
    commandId: "c-1",
  };
  const context = {
    authority,
    registry,
    clock: (): string => "2026-10-10T12:00:00.000Z",
    livenessMilliseconds: 1,
    followMilliseconds: 1,
    resolverMilliseconds: 1000,
    textBytes: 1000,
    documentBytes: 1000,
  };
  const rejected = await submissionHandler({
    ...context,
    gateway: {
      execute: () =>
        Promise.resolve({ kind: "rejected", reason: "terminal-run" }),
    },
  })(parameters);
  assert.deepEqual(rejected, {
    kind: "error",
    error: { commandId: "c-1", code: "terminal-run", detail: "terminal-run" },
  });
  const lost = await submissionHandler({
    ...context,
    gateway: {
      execute: () =>
        Promise.resolve({ kind: "accepted", sequence: 1, intents: [] }),
    },
  })(parameters);
  assert.equal(field(field(lost, "error"), "code"), "conflicting-command");
  await authority.close();
  const closed = submissionHandler({
    ...context,
    gateway: commandGateway({
      authority,
      registry,
      clock: context.clock,
      textBytes: 1000,
    }),
  });
  const [first, second] = await Promise.allSettled([
    closed(parameters),
    closed(parameters),
  ]);
  assert.deepEqual([first.status, second.status], ["rejected", "rejected"]);
});

await test("CLV-008 a resolver result with a wrong form is not a resolution", () => {
  for (const value of [
    undefined,
    null,
    "resolved",
    [],
    {},
    { kind: "done" },
    { kind: "resolved" },
    { kind: "resolved", input: undefined },
    { kind: "rejected" },
    { kind: "rejected", code: 5, detail: "x" },
    { kind: "rejected", code: "", detail: "x" },
  ])
    assert.equal(checkResolution(value), undefined, JSON.stringify(value));
  assert.deepEqual(checkResolution({ kind: "resolved", input: { a: 1 } }), {
    kind: "resolved",
    input: '{"a":1}',
  });
  assert.deepEqual(checkResolution({ kind: "rejected", code: "closed" }), {
    kind: "rejected",
    code: "closed",
    detail: "closed",
  });
});

await test("CLV-008 the question counter of a stored state with 200 000 gates is the highest label", () => {
  const gates = Array.from({ length: 200_000 }, (_, index) => ({
    ...row,
    gateId: `design-${String(index)}`,
    label: index + 1,
  }));
  assert.equal(decisionState({ gates, details: [] }).questions, 200_000);
  assert.equal(decisionState({ gates: [], details: [] }).questions, 0);
});

await test("CLV-168 registry pins current and retained handoff permissions without sharing the declaration array", () => {
  const handoffs = ["b"];
  const registration = fakeRegistration([]);
  const registry = workflowRegistry(
    [{ ...registration, handoffs }],
    [{ ...registration, handoffs: ["c"] }],
  );
  const current = registry.byId("develop");
  assert.ok(current);
  assert.deepEqual(current.manifest.handoffs, ["b"]);
  handoffs.push("c");
  assert.deepEqual(current.handoffs, ["b"]);
  assert.deepEqual(current.manifest.handoffs, ["b"]);
  const retained = workflowRegistry([
    { ...registration, handoffs: ["c"] },
  ]).byId("develop");
  assert.ok(retained);
  assert.notEqual(current.pin, retained.pin);
  assert.deepEqual(registry.byPin(retained.pin)?.manifest.handoffs, ["c"]);
  assert.deepEqual(registry.available(current.manifest), current.manifest);
});
