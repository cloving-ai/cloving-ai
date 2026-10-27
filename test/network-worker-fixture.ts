import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scene } from "./claude-worker-fixture.ts";

export const networkContinuation =
  "An earlier attempt stopped because the network was not available. Continue from the current state of the work tree. Check each earlier commit, push, review comment and message. Do not repeat a write that is done. Stop and report a write whose result is not known.";

export function networkCommand(
  scene: Scene,
  failures:
    | readonly string[]
    | { readonly failures: readonly string[]; readonly worker: "codex" },
): readonly string[] {
  const settings =
    "worker" in failures ? failures : { failures, worker: "claude" };
  const script = join(scene.directory, "network-worker.mjs");
  writeFileSync(
    script,
    `
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [log, failures, worker] = process.argv.slice(2);
const attempt = readFileSync(log, "utf8").split("\\n").length;
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(log, JSON.stringify({ prompt, arguments: process.argv.slice(5), directory: process.cwd() }) + "\\n");
execFileSync("git", ["commit", "--allow-empty", "-m", "Attempt " + attempt], { stdio: "ignore" });
const failure = JSON.parse(failures)[attempt - 1] ?? "done";
const messages = {
  "network-overloaded": "API Error: Can't reach the API server ... (ENOTFOUND)",
  network: "API Error: Can't reach the API server ... (ENOTFOUND)",
  capacity: "Selected model is at capacity. Please try a different model.",
  bad: "API Error: 400 invalid request",
};
if (failure === "network-overloaded") console.log(JSON.stringify({ type: "assistant", error: "overloaded", parent_tool_use_id: null }));
if (worker === "codex") console.log(JSON.stringify({ type: "turn.failed", error: { message: messages[failure] } }));
else console.log(JSON.stringify({ type: "result", subtype: "success", is_error: failure !== "done", terminal_reason: "api_error", result: messages[failure] ?? "Done", total_cost_usd: attempt / 10, num_turns: attempt, usage: { input_tokens: attempt * 100, cache_read_input_tokens: 0, output_tokens: attempt * 10 } }));
process.exitCode = failure === "done" ? 0 : 1;
`,
  );
  return [
    process.execPath,
    script,
    join(scene.directory, "turns.log"),
    JSON.stringify(settings.failures),
    settings.worker,
    "--model",
    "main",
  ];
}
