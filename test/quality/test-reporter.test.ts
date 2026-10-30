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

await test("a failure with a large error value keeps a bounded report entry", async () => {
  const event = failedEvent("large value", "assertion.test.ts");
  event.data.details.error = Object.assign(new Error("x".repeat(5_000_000)), {
    actual: "y".repeat(5_000_000),
    expected: Array.from({ length: 1_000_000 }, (_, index) => index),
  });
  const failures = await failuresOf([event]);
  assert.ok(failures[0] && typeof failures[0] === "object");
  const error: unknown = Reflect.get(failures[0], "error");
  const message: unknown = Reflect.get(failures[0], "message");
  assert.equal(typeof error, "string");
  assert.equal(typeof message, "string");
  assert.ok(String(error).length <= 100_000, String(String(error).length));
  assert.ok(String(message).length <= 100_000, String(String(message).length));
  assert.match(String(message), /^x{100}/);
});
