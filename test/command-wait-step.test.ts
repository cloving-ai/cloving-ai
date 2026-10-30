import assert from "node:assert/strict";
import { test } from "node:test";
import { registerStepBridge } from "../src/host/step-bridge-host.ts";
import { waitForCommand } from "../src/workflows.ts";
import {
  openCommandWait,
  checkCommandWait,
} from "../src/steps/command-wait.ts";
import type { StepBridge } from "../src/step-bridge.ts";

const request = { name: "team-review", input: { change: 42 } };
const unused = {
  effect: () => Promise.resolve({ kind: "refused" as const, reason: "unused" }),
  gate: () => Promise.resolve({ kind: "refused" as const, reason: "unused" }),
};

await test("CLV-237 only name and serializable input cross the command-wait bridge", async () => {
  const calls: unknown[] = [];
  const bridge: StepBridge = {
    ...unused,
    openCommandWait: (given) => {
      calls.push(given);
      return Promise.resolve({ kind: "ready", value: { approved: true } });
    },
  };
  const remove = registerStepBridge(bridge);
  try {
    assert.deepEqual(await waitForCommand(request), {
      kind: "ready",
      value: { approved: true },
    });
    assert.deepEqual(calls, [request]);
  } finally {
    remove();
  }
});

await test("CLV-237 command waits explicitly refuse an absent host and unknown waits", async () => {
  assert.deepEqual(await waitForCommand(request), {
    kind: "unavailable",
    reason: "cloving-host-unavailable",
  });
  const remove = registerStepBridge({
    ...unused,
    openCommandWait: () =>
      Promise.resolve({ kind: "refused", reason: "command-wait-not-declared" }),
  });
  try {
    assert.deepEqual(await waitForCommand(request), {
      kind: "refused",
      reason: "command-wait-not-declared",
    });
  } finally {
    remove();
  }
});

await test("CLV-237 command waits refuse extra fields and nonserializable input before dispatch", async () => {
  let calls = 0;
  const remove = registerStepBridge({
    ...unused,
    openCommandWait: () => {
      calls += 1;
      return Promise.resolve({ kind: "ready", value: null });
    },
  });
  try {
    for (const key of [
      "callback",
      "executable",
      "arguments",
      "deadline",
      "exemption",
      "units",
      "scope",
    ])
      assert.deepEqual(await waitForCommand({ ...request, [key]: "forged" }), {
        kind: "refused",
        reason: "invalid-command-wait-request",
      });
    for (const input of [
      undefined,
      () => undefined,
      NaN,
      Infinity,
      1n,
      new Date(),
      { callback() {} },
      { nested: undefined },
    ])
      assert.deepEqual(
        await Reflect.apply(waitForCommand, undefined, [{ ...request, input }]),
        {
          kind: "refused",
          reason: "invalid-command-wait-request",
        },
      );
    assert.equal(calls, 0);
  } finally {
    remove();
  }
});

await test("CLV-237 the workflow loop suspends between checks and wakes at the deadline", async () => {
  const calls: unknown[] = [];
  const sleeps: unknown[] = [];
  const pending = {
    kind: "pending" as const,
    deadline: 30000,
    nextCheckAt: 10000,
  };
  const results = [
    pending,
    { ...pending, nextCheckAt: 40000 },
    { kind: "timed-out" as const, reason: "command-wait-timeout" },
  ];
  const remove = registerStepBridge({
    ...unused,
    openCommandWait: (given) => {
      calls.push(given);
      return Promise.resolve(pending);
    },
    checkCommandWait: (given) => {
      calls.push(given);
      const result = results.shift();
      assert.ok(result);
      return Promise.resolve(result);
    },
  });
  const key = Symbol.for("WORKFLOW_SLEEP");
  Reflect.set(globalThis, key, (when: Date) => {
    sleeps.push(when.getTime());
    return Promise.resolve();
  });
  try {
    assert.deepEqual(await waitForCommand(request), {
      kind: "timed-out",
      reason: "command-wait-timeout",
    });
    assert.deepEqual(calls, [
      request,
      { name: request.name },
      { name: request.name },
      { name: request.name },
    ]);
    assert.deepEqual(sleeps, [10000, 30000]);
  } finally {
    Reflect.deleteProperty(globalThis, key);
    remove();
  }
});

await test("CLV-237 JSON arrays, primitives and nested objects remain serializable wait input", async () => {
  const calls: unknown[] = [];
  const remove = registerStepBridge({
    ...unused,
    openCommandWait: (request) => {
      calls.push(request);
      return Promise.resolve({ kind: "ready", value: null });
    },
  });
  try {
    const input = [null, true, "review", 42, { choices: [false] }];
    assert.deepEqual(await waitForCommand({ name: "team-review", input }), {
      kind: "ready",
      value: null,
    });
    assert.deepEqual(calls, [{ name: "team-review", input }]);
  } finally {
    remove();
  }
});

await test("CLV-237 validation refuses accessors, hidden fields, symbols, cycles and sparse arrays without invoking code", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  const accessor = {
    get value() {
      throw new Error("getter-must-not-run");
    },
  };
  const hidden = Object.defineProperty({}, "hidden", { value: 1 });
  for (const input of [
    cyclic,
    accessor,
    hidden,
    { [Symbol("secret")]: 1 },
    Array(2),
  ])
    assert.deepEqual(
      await Reflect.apply(waitForCommand, undefined, [
        { name: "team-review", input },
      ]),
      { kind: "refused", reason: "invalid-command-wait-request" },
    );
  for (const request of [
    null,
    [],
    {},
    { name: "", input: null },
    { name: 1, input: null },
    {
      get name() {
        throw new Error("getter-must-not-run");
      },
      input: null,
    },
  ])
    assert.deepEqual(
      await Reflect.apply(waitForCommand, undefined, [request]),
      { kind: "refused", reason: "invalid-command-wait-request" },
    );
  assert.deepEqual(await openCommandWait({ name: "", input: null }), {
    kind: "refused",
    reason: "invalid-command-wait-request",
  });
  assert.deepEqual(await checkCommandWait({ name: "team-review" }), {
    kind: "unavailable",
    reason: "cloving-host-unavailable",
  });
});

await test("CLV-237 inherited array callbacks are refused before serializing input", async () => {
  const input = [1, 2];
  Object.setPrototypeOf(input, {
    toJSON() {
      throw new Error("callback-must-not-run");
    },
  });
  assert.deepEqual(
    await Reflect.apply(waitForCommand, undefined, [
      { name: "team-review", input },
    ]),
    { kind: "refused", reason: "invalid-command-wait-request" },
  );
});
