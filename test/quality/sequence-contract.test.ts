import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectTypedFixture } from "./typed-fixture.ts";

type Composition = (
  step: () => Promise<void>,
  advance: () => void,
) => Promise<void> | void;

async function traceComposition(compose: Composition): Promise<string[]> {
  const trace: string[] = [];
  const barrier = Promise.withResolvers<undefined>();
  const settled = Promise.withResolvers<undefined>();
  const step = async () => {
    trace.push("step-started");
    await barrier.promise;
    trace.push("step-committed");
    settled.resolve(undefined);
  };
  const completed = compose(step, () => {
    trace.push("continuation");
  });
  barrier.resolve(undefined);
  await completed;
  await settled.promise;
  return trace;
}

await test("QG-17 awaited checkpoint precedes continuation at a controlled barrier", async () => {
  const trace = await traceComposition(async (step, advance) => {
    await step();
    advance();
  });
  assert.deepEqual(trace, ["step-started", "step-committed", "continuation"]);
});

await test("QG-17 sequencing rejects handled detached work that promise lint accepts", async () => {
  const syntax = await inspectTypedFixture({
    "fixture.ts":
      "declare function step(): Promise<void>; export function workflow(): void { step().catch(() => undefined); }",
  });
  assert.deepEqual(
    syntax.lint.flatMap((file) => file.messages),
    [],
  );
  const trace = await traceComposition((step, advance) => {
    step().catch(() => undefined);
    advance();
  });
  assert.deepEqual(trace, ["step-started", "continuation", "step-committed"]);
  assert.throws(() => {
    assert.deepEqual(trace, ["step-started", "step-committed", "continuation"]);
  }, assert.AssertionError);
});
