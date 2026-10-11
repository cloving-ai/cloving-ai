import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  call,
  field,
  withHarness,
  testTiming,
  type Harness,
} from "./service-fixture.ts";

function run(
  harness: Harness,
  parameters: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  return call(harness, {
    operation: "run",
    parameters: {
      workflowId: "develop",
      source: "prompt",
      submission: { prompt: "task" },
      commandId: "c-run",
      ...parameters,
    },
  });
}

await test("CLV-008 a resolver that gives no result ends with resolver-timeout, and a retry with the same command ID is admitted", () =>
  withHarness(async (harness) => {
    let calls = 0;
    const service = await harness.start({
      timing: { ...testTiming, resolverMilliseconds: 150 },
      workflows: [
        {
          ...harness.registration,
          resolver: {
            id: "slow-resolver",
            version: "1",
            resolve: () => {
              calls += 1;
              return calls === 1
                ? new Promise(() => undefined)
                : Promise.resolve({
                    kind: "resolved",
                    input: { cycleId: "cycle-1" },
                  });
            },
          },
        },
      ],
    });
    const first = await run(harness, {});
    assert.deepEqual(
      [field(first, "kind"), field(first, "code"), field(first, "commandId")],
      ["error", "resolver-timeout", "c-run"],
    );
    const events = await call(harness, {
      operation: "events",
      parameters: { after: 0, limit: 10 },
    });
    assert.deepEqual(field(events, "events"), []);
    const second = await run(harness, {});
    assert.deepEqual(
      [field(second, "kind"), field(second, "replayed"), calls],
      ["run-admitted", false, 2],
    );
    await service.close();
  }));

await test("CLV-008 an execution input or a submission above the document limit is rejected, and the service stays in use", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [
        {
          ...harness.registration,
          submission: { maximumBytes: 600_000, fields: { prompt: "string" } },
          resolver: {
            id: "large-resolver",
            version: "1",
            resolve: (request) =>
              Promise.resolve({
                kind: "resolved",
                input: {
                  text: "x".repeat(
                    request.commandId === "c-input" ? 1_100_000 : 10,
                  ),
                },
              }),
          },
        },
      ],
    });
    const quotes = await run(harness, {
      commandId: "c-quotes",
      submission: { prompt: "x".repeat(300_000) },
    });
    assert.deepEqual(
      [field(quotes, "kind"), field(quotes, "code")],
      ["error", "input-too-large"],
    );
    const input = await run(harness, { commandId: "c-input" });
    assert.deepEqual(
      [field(input, "kind"), field(input, "code"), field(input, "commandId")],
      ["error", "resolver-failure", "c-input"],
    );
    const events = await call(harness, {
      operation: "events",
      parameters: { after: 0, limit: 10 },
    });
    assert.deepEqual(field(events, "events"), []);
    const admitted = await run(harness, { commandId: "c-small" });
    assert.equal(field(admitted, "kind"), "run-admitted");
    await service.close();
  }));

type Resolve = Harness["registration"]["resolver"]["resolve"];

const cyclic: Record<string, unknown> = {};
cyclic["self"] = cyclic;

const faults: Readonly<Record<string, Resolve>> = {
  "c-throw": () => {
    throw new Error("resolver bug");
  },
  "c-reject": () => Promise.reject(new Error("resolver bug")),
  "c-unusable": () => Promise.resolve({ kind: "resolved", input: undefined }),
  "c-cyclic": () => Promise.resolve({ kind: "resolved", input: cyclic }),
  "c-unreadable": () =>
    Promise.resolve({
      get kind(): "resolved" {
        throw new Error("resolver bug");
      },
      input: {},
    }),
  "c-slow": () => new Promise(() => undefined),
  "c-correct": () =>
    Promise.resolve({ kind: "resolved", input: { cycleId: "cycle-1" } }),
};

await test("CLV-008 a resolver that throws, rejects, gives an input that JSON cannot hold or a result that cannot be read ends with resolver-failure, and only the time limit aborts its signal", () =>
  withHarness(async (harness) => {
    const signals: AbortSignal[] = [];
    const service = await harness.start({
      timing: { ...testTiming, resolverMilliseconds: 150 },
      workflows: [
        {
          ...harness.registration,
          resolver: {
            id: "faulty-resolver",
            version: "1",
            resolve: (request) => {
              signals.push(request.signal);
              const fault = faults[request.commandId] ?? faults["c-reject"];
              return fault === undefined
                ? Promise.reject(new Error("no fault"))
                : fault(request);
            },
          },
        },
      ],
    });
    const codes: unknown[] = [];
    for (const commandId of Object.keys(faults))
      codes.push(field(await run(harness, { commandId }), "code"));
    assert.deepEqual(codes, [
      "resolver-failure",
      "resolver-failure",
      "resolver-failure",
      "resolver-failure",
      "resolver-failure",
      "resolver-timeout",
      undefined,
    ]);
    assert.deepEqual(
      signals.map((signal) => signal.aborted),
      [false, false, false, false, false, true, false],
    );
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.equal(JSON.stringify(field(status, "runs")).includes("run-"), true);
    await service.close();
  }));

await test("CLV-008 three submissions with one command ID during one slow resolver call commit one run and call the resolver one time", () =>
  withHarness(async (harness) => {
    let calls = 0;
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const service = await harness.start({
      workflows: [
        {
          ...harness.registration,
          resolver: {
            id: "barrier-resolver",
            version: "1",
            resolve: async () => {
              calls += 1;
              entered.resolve(undefined);
              await release.promise;
              return { kind: "resolved", input: { cycleId: "cycle-1" } };
            },
          },
        },
      ],
    });
    const replies = [run(harness, {}), run(harness, {}), run(harness, {})];
    await entered.promise;
    await delay(150);
    release.resolve(undefined);
    const settled = await Promise.all(replies);
    assert.deepEqual(
      settled.map((reply) => field(reply, "kind")),
      ["run-admitted", "run-admitted", "run-admitted"],
    );
    assert.deepEqual(settled.map((reply) => field(reply, "replayed")).sort(), [
      false,
      true,
      true,
    ]);
    assert.equal(
      new Set(settled.map((reply) => field(reply, "runId"))).size,
      1,
    );
    assert.equal(calls, 1);
    await service.close();
  }));
