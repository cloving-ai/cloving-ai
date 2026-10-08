import { resolve } from "node:path";
import { inspect } from "node:util";
import type { TestEvent } from "node:test/reporters";

export default async function* reportTests(
  source: AsyncIterable<TestEvent>,
): AsyncGenerator<string> {
  let completed = 0;
  const files = new Set<string>();
  const failures: string[] = [];
  for await (const event of source) {
    if (event.type === "test:fail") {
      failures.push(`${event.data.name}: ${inspect(event.data.details.error)}`);
      continue;
    }
    if (event.type !== "test:pass") continue;
    const result = event.data;
    if (result.details.type !== "test" || result.skip || result.todo) continue;
    if (!result.file || resolve(result.name) === resolve(result.file)) continue;
    completed += 1;
    files.add(resolve(result.file));
  }
  yield JSON.stringify({ completed, files: [...files].sort(), failures });
}
