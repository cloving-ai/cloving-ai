import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import type { TestEvent } from "node:test/reporters";
import reportDurations from "../../quality/test-duration-reporter.ts";

function passed(
  file: string,
  result: {
    readonly milliseconds: number;
    readonly nesting?: number;
    readonly type?: "suite" | "test";
  },
): TestEvent {
  return {
    type: "test:pass",
    data: {
      file: resolve(file),
      name: "passes",
      nesting: result.nesting ?? 0,
      parentId: undefined,
      tags: [],
      testId: 1,
      testNumber: 1,
      details: {
        duration_ms: result.milliseconds,
        type: result.type ?? "test",
      },
    },
  };
}

async function outputOf(events: readonly TestEvent[]): Promise<string> {
  const source: AsyncIterable<TestEvent> = {
    [Symbol.asyncIterator]: () => {
      const iterator = events[Symbol.iterator]();
      return { next: () => Promise.resolve(iterator.next()) };
    },
  };
  const output: string[] = [];
  for await (const chunk of reportDurations(source)) output.push(chunk);
  return output.join("");
}

await test("CLV-174 records seconds from top-level tests and suites without double counting", async () => {
  const output = await outputOf([
    { type: "test:stderr", data: { file: "test/a.test.ts", message: "noise" } },
    passed("test/z.test.ts", { milliseconds: 500 }),
    passed("test/a.test.ts", { milliseconds: 2000 }),
    passed("test/a.test.ts", { milliseconds: 900000, nesting: 1 }),
    passed("test/a.test.ts", { milliseconds: 3000, type: "suite" }),
  ]);
  const record: unknown = JSON.parse(output);
  assert.deepEqual(record, { "test/a.test.ts": 5, "test/z.test.ts": 0.5 });
  assert.equal(output, '{"test/a.test.ts":5,"test/z.test.ts":0.5}');
});

await test("CLV-174 refuses duration records with skipped or TODO tests", async () => {
  const event = passed("test/main.test.ts", { milliseconds: 1000 });
  assert.equal(event.type, "test:pass");
  for (const flag of ["skip", "todo"])
    await assert.rejects(
      outputOf([{ ...event, data: { ...event.data, [flag]: true } }]),
      /incomplete-test-duration-run/,
    );
});
