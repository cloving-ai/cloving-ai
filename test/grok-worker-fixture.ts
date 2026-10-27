import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeWorkerSettings } from "../src/daemon/claude-worker.ts";
import {
  intent,
  resultOf,
  until,
  type Scene,
} from "./claude-worker-fixture.ts";

export const grokReport = "Added the worker.\nTicket status: complete";
export const grokUsage = {
  input_tokens: 812,
  cache_creation_input_tokens: 100,
  cache_read_input_tokens: 200,
  output_tokens: 210,
};
export const grokResult = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: grokReport,
  usage: grokUsage,
  total_cost_usd: 0.0127,
  modelUsage: {},
  session_id: "abc123",
  num_turns: 7,
};
export const grokMessages = [
  { type: "system", subtype: "init", model: "grok-4.6", session_id: "abc123" },
  {
    type: "assistant",
    message: {
      id: "msg_0",
      role: "assistant",
      model: "grok-4.6",
      content: [{ type: "text", text: "Let me read the file." }],
      usage: { ...grokUsage, input_tokens: 90_000 },
    },
    parent_tool_use_id: null,
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", content: "fn main() {}", tool_use_id: "call_1" },
      ],
    },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      model: "grok-4.6",
      content: [{ type: "text", text: grokReport }],
      usage: grokUsage,
    },
    parent_tool_use_id: null,
  },
];
export const incompleteWarning =
  "WARN streaming-messages-json: usage is incomplete; `result.usage` token counts may under-count or fall back to zero (the Messages API schema has no incompleteness marker)";

export async function grokTurn(
  scene: Scene,
  options: {
    readonly result?: unknown;
    readonly events?: readonly unknown[];
    readonly stderr?: string;
    readonly exitCode?: number;
    readonly settings?: Partial<ClaudeWorkerSettings>;
    readonly prompt?: string;
    readonly environment?: Readonly<Record<string, string>>;
  } = {},
) {
  const program = join(scene.directory, "grok");
  const observed = join(scene.directory, "observed.json");
  const events = options.events ?? [
    ...grokMessages,
    options.result ?? grokResult,
  ];
  writeFileSync(
    program,
    `#!${process.execPath}
import {execFileSync} from "node:child_process";
import {writeFileSync,readdirSync} from "node:fs";
let stdin = "";
for await (const chunk of process.stdin) stdin += String(chunk);
writeFileSync(${JSON.stringify(observed)}, JSON.stringify({stdin,arguments:process.argv.slice(2),directory:process.cwd(),tokens:Object.keys(process.env).filter(name => /^(GH|GITHUB)(_ENTERPRISE)?_TOKEN$/.test(name)),configuration:readdirSync(process.env.GH_CONFIG_DIR)}));
writeFileSync("grok.txt", "worker change");
execFileSync("git", ["add", "grok.txt"]);
execFileSync("git", ["commit", "--quiet", "-m", "Add grok fixture change"]);
process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n"))});
process.stderr.write(${JSON.stringify(options.stderr ?? "")});
process.exitCode = ${String(options.exitCode ?? 0)};
`,
    { mode: 0o700 },
  );
  const worker = scene.worker("bare", {
    harness: { name: "grok", kind: "file", path: program },
    document: () => Promise.resolve(options.prompt ?? "Do the work"),
    profiles: { grok: { env: options.environment ?? {} } },
    ...options.settings,
  });
  await worker.deliver(
    intent({ method: "run-turn:grok" }),
    new AbortController().signal,
  );
  await until(() => scene.reports.length === 1);
  return {
    report: scene.reports[0],
    result: resultOf(scene.reports[0]?.result ?? "{}"),
    observed: resultOf(readFileSync(observed, "utf8")),
  };
}

export const grokModelUsage = {
  inputTokens: 812,
  cacheCreationInputTokens: 100,
  cacheReadInputTokens: 200,
  outputTokens: 210,
};
