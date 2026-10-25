import type { TestEvent } from "node:test/reporters";
import { relative } from "node:path";

export default async function* reportDurations(
  source: AsyncIterable<TestEvent>,
): AsyncGenerator<string> {
  const durations = new Map<string, number>();
  for await (const event of source) {
    if (event.type === "test:fail")
      throw new Error(`incomplete-test-duration-run: ${event.data.name}`, {
        cause: event.data.details.error,
      });
    if (event.type !== "test:pass") continue;
    const result = event.data;
    if (result.skip || result.todo)
      throw new Error(`incomplete-test-duration-run: ${result.name}`);
    if (result.nesting !== 0 || !result.file) continue;
    const file = relative(process.cwd(), result.file);
    durations.set(
      file,
      (durations.get(file) ?? 0) + result.details.duration_ms / 1000,
    );
  }
  yield JSON.stringify(Object.fromEntries([...durations].sort()));
}
