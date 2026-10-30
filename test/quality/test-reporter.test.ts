import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import type { TestEvent } from "node:test/reporters";
import reportTests from "../../quality/test-reporter.ts";

function eventSource(events: readonly TestEvent[]): AsyncIterable<TestEvent> {
  return {
    [Symbol.asyncIterator]: () => {
      const iterator = events[Symbol.iterator]();
      return { next: () => Promise.resolve(iterator.next()) };
    },
  };
}

async function failuresOf(events: readonly TestEvent[]): Promise<unknown[]> {
  const output: string[] = [];
  for await (const chunk of reportTests(eventSource(events)))
    output.push(chunk);
  const report: unknown = JSON.parse(output.join(""));
  assert.ok(report !== null && typeof report === "object");
  const failures: unknown = Reflect.get(report, "failures");
  assert.ok(Array.isArray(failures));
  return Array.from<unknown>(failures);
}

function failureWithoutError(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object");
  const { error, ...fields } = Object.fromEntries(Object.entries(value));
  assert.equal(typeof error, "string");
  return fields;
}

function stderrEvent(file: string, message: string): TestEvent {
  return { type: "test:stderr", data: { file, message } };
}

function failedEvent(
  name: string,
  file: string,
): Extract<TestEvent, { type: "test:fail" }> {
  return {
    type: "test:fail",
    data: {
      name,
      file,
      nesting: 0,
      parentId: undefined,
      tags: [],
      testId: 1,
      testNumber: 1,
      details: {
        duration_ms: 1,
        error: Object.assign(new Error("test failed"), {
          cause: "test failed",
        }),
      },
    },
  };
}

await test("CLV-164 a whole failed test file keeps the last lines of its stderr", async () => {
  const file = resolve("test/crash.test.ts");
  const lines = Array.from(
    { length: 25 },
    (_, index) => `line ${String(index)}`,
  );
  const failures = await failuresOf([
    stderrEvent(file, `${lines.slice(0, 10).join("\n")}\n`),
    stderrEvent(file, `${lines.slice(10).join("\n")}\n`),
    failedEvent(file, file),
  ]);
  assert.equal(failures.length, 1);
  assert.deepEqual(failureWithoutError(failures[0]), {
    name: file,
    file,
    message: "test failed",
    stderr: lines.slice(5),
  });
});

await test("CLV-164 a failed test keeps its message and adds no stderr of its file", async () => {
  const file = resolve("test/assertion.test.ts");
  const failures = await failuresOf([
    stderrEvent(file, "noise\n"),
    failedEvent("a single test", file),
  ]);
  assert.equal(failures.length, 1);
  assert.deepEqual(failureWithoutError(failures[0]), {
    name: "a single test",
    file,
    message: "test failed",
    stderr: [],
  });
});

await test("CLV-164 failures retain event locations and the complete message", async () => {
  const event = failedEvent("assertion", "assertion.test.ts");
  event.data.line = 12;
  event.data.column = 34;
  event.data.details.error.message = "first cause\nsecond line";
  assert.deepEqual((await failuresOf([event])).map(failureWithoutError), [
    {
      name: "assertion",
      file: "assertion.test.ts",
      line: 12,
      column: 34,
      message: "first cause\nsecond line",
      stderr: [],
    },
  ]);
});

await test("CLV-164 retained stderr lines remain bounded to 500 characters", async () => {
  const file = resolve("test/crash.test.ts");
  assert.deepEqual(
    (
      await failuresOf([
        stderrEvent(file, `${"x".repeat(501)}\n\nlast\n`),
        failedEvent(file, file),
      ])
    ).map(failureWithoutError),
    [
      {
        name: file,
        file,
        message: "test failed",
        stderr: ["x".repeat(500), "last"],
      },
    ],
  );
});

await test("CLV-164 retains complete nested errors in the saved failure data", async () => {
  const event = failedEvent("nested error", "assertion.test.ts");
  const cause = new Error("root cause\nroot detail");
  event.data.details.error = Object.assign(
    new Error("first cause\nsecond line"),
    {
      cause: new Error("middle cause", { cause }),
    },
  );
  const failures = await failuresOf([event]);
  assert.ok(failures[0] && typeof failures[0] === "object");
  const details: unknown = Reflect.get(failures[0], "error");
  assert.equal(typeof details, "string");
  assert.match(String(details), /first cause\nsecond line/);
  assert.match(String(details), /middle cause/);
  assert.match(String(details), /root cause\n\s*root detail/);
  assert.match(String(details), /test-reporter\.test\.ts:\d+:\d+/);
});

function savedFailure(failure: unknown): { error: string; message: string } {
  assert.ok(failure !== null && typeof failure === "object");
  const error: unknown = Reflect.get(failure, "error");
  const message: unknown = Reflect.get(failure, "message");
  assert.ok(typeof error === "string");
  assert.ok(typeof message === "string");
  return { error, message };
}

await test("a failure with a large error value keeps a bounded report entry", async () => {
  const event = failedEvent("large value", "assertion.test.ts");
  event.data.details.error = Object.assign(new Error("x".repeat(5_000_000)), {
    cause: {
      actual: "y".repeat(5_000_000),
      expected: Array.from({ length: 1_000_000 }, (_, index) => index),
    },
  });
  const { error, message } = savedFailure((await failuresOf([event]))[0]);
  assert.ok(error.length <= 100_000, String(error.length));
  assert.ok(message.length <= 100_000, String(message.length));
  assert.match(message, /^x{100}/);
  assert.match(error, /test-reporter\.test\.ts:\d+:\d+/);
  assert.match(error, /actual: 'y{100}/);
});

await test("a failure reads only a bounded number of properties of a large error value", async () => {
  const event = failedEvent("many properties", "assertion.test.ts");
  let reads = 0;
  const value = {};
  for (let index = 0; index < 2_000; index += 1)
    Object.defineProperty(value, `field${String(index)}`, {
      enumerable: true,
      get: () => {
        reads += 1;
        return "z".repeat(10_000);
      },
    });
  event.data.details.error = Object.assign(new Error("many properties"), {
    cause: value,
  });
  const { error } = savedFailure((await failuresOf([event]))[0]);
  assert.ok(reads <= 100, String(reads));
  assert.ok(error.length <= 100_000, String(error.length));
  assert.match(error, /field0: 'z{100}/);
});

await test("a failure keeps built-in values and bounds large collections", async () => {
  const event = failedEvent("built-in values", "assertion.test.ts");
  event.data.details.error = Object.assign(new Error("built-in values"), {
    cause: {
      map: new Map([["a", 1]]),
      set: new Set([2]),
      date: new Date(0),
      pattern: /x+/g,
      bytes: new Uint8Array(3),
      large: new Map(
        Array.from({ length: 1_000 }, (_, index) => [index, index]),
      ),
    },
  });
  const { error } = savedFailure((await failuresOf([event]))[0]);
  assert.match(error, /Map\(1\) \{ 'a' => 1 \}/);
  assert.match(error, /Set\(1\) \{ 2 \}/);
  assert.match(error, /1970-01-01T00:00:00\.000Z/);
  assert.match(error, /\/x\+\/g/);
  assert.match(error, /Uint8Array\(3\)/);
  assert.match(error, /omitted: 900/);
});

await test("a failure bounds large built-in values and keeps distinct entries and empty slots", async () => {
  const event = failedEvent("edge values", "assertion.test.ts");
  const date = Object.assign(
    new Date(0),
    Object.fromEntries(
      Array.from({ length: 2_000 }, (_, index) => [
        `f${String(index)}`,
        "d".repeat(10_000),
      ]),
    ),
  );
  const prefix = "k".repeat(20_000);
  event.data.details.error = Object.assign(new Error("edge values"), {
    cause: {
      date,
      pattern: new RegExp("p".repeat(5_000_000)),
      bytes: new Uint8Array(1_000),
      keys: new Map([
        [`${prefix}a`, "first"],
        [`${prefix}b`, "second"],
        ["...", "real entry"],
      ]),
      holes: Object.assign(new Array<unknown>(2), { 1: 1 }),
    },
  });
  const { error } = savedFailure((await failuresOf([event]))[0]);
  assert.ok(error.length <= 100_000, String(error.length));
  assert.match(error, /1970-01-01T00:00:00\.000Z/);
  assert.match(error, /first/);
  assert.match(error, /second/);
  assert.match(error, /real entry/);
  assert.match(error, /<1 empty item>/);
  assert.match(error, /Uint8Array\(1000\)/);
});
