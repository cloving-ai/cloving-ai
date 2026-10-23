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

async function failuresOf(events: readonly TestEvent[]): Promise<string[]> {
  const output: string[] = [];
  for await (const chunk of reportTests(eventSource(events)))
    output.push(chunk);
  const report: unknown = JSON.parse(output.join(""));
  const failures: unknown = Reflect.get(Object(report), "failures");
  assert.ok(Array.isArray(failures));
  return failures.map(String);
}

function stderrEvent(file: string, message: string): TestEvent {
  return { type: "test:stderr", data: { file, message } };
}

function failedEvent(name: string, file: string): TestEvent {
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
  assert.match(failures[0] ?? "", /stderr:\nline 5\n/);
  assert.match(failures[0] ?? "", /line 24$/);
  assert.doesNotMatch(failures[0] ?? "", /line 4\n/);
});

await test("CLV-164 a failed test keeps its message and adds no stderr of its file", async () => {
  const file = resolve("test/assertion.test.ts");
  const failures = await failuresOf([
    stderrEvent(file, "noise\n"),
    failedEvent("a single test", file),
  ]);
  assert.equal(failures.length, 1);
  assert.ok(failures[0]?.startsWith("a single test: Error: test failed"));
  assert.doesNotMatch(failures[0] ?? "", /noise/);
});
