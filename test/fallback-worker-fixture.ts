import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scene } from "./claude-worker-fixture.ts";

export function fallbackCommand(scene: Scene): readonly string[] {
  const script = join(scene.directory, "fallback-worker.mjs");
  writeFileSync(
    script,
    `
import { appendFileSync, readFileSync } from "node:fs";
const [log, ...argumentsList] = process.argv.slice(2);
const attempt = readFileSync(log, "utf8").split("\\n").length;
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(log, JSON.stringify({ prompt, arguments: argumentsList, directory: process.cwd() }) + "\\n");
const print = (event) => console.log(JSON.stringify(event));
print({ type: "thread.started", thread_id: "thread-" + attempt });
print({ type: "turn.completed", usage: { input_tokens: attempt * 1000000, cached_input_tokens: attempt * 400000, output_tokens: attempt * 100000 } });
if (attempt < 3) print({ type: "turn.failed", error: { message: "Selected model is at capacity. Please try a different model." } });
else print({ type: "item.completed", item: { type: "agent_message", text: "Done" } });
`,
  );
  return [
    process.execPath,
    script,
    join(scene.directory, "turns.log"),
    "-m",
    "gpt-6.1-sol",
  ];
}
