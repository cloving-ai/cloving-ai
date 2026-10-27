import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scene } from "./claude-worker-fixture.ts";

export const geminiSources = [
  "https://geminicli.com/docs/cli/headless/",
  "https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/types.ts",
  "https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/nonInteractiveCli.ts",
];

export const geminiReport = "Added HELLO.md.\nTicket status: complete";

export const chunkStream = [
  { type: "init", session_id: "gemini-session", model: "gemini-test-pro" },
  { type: "message", role: "user", content: "Add HELLO.md." },
  { type: "message", role: "assistant", content: "Working.", delta: true },
  {
    type: "tool_use",
    tool_name: "write_file",
    tool_id: "write",
    parameters: { file_path: "HELLO.md", content: "Hello.\n" },
  },
  { type: "tool_result", tool_id: "write", status: "success" },
  { type: "message", role: "assistant", content: "Added ", delta: true },
  { type: "message", role: "assistant", content: "HELLO.md.\n", delta: true },
  {
    type: "message",
    role: "assistant",
    content: "Ticket status: ",
    delta: true,
  },
  { type: "message", role: "assistant", content: "complete", delta: true },
  { type: "result", status: "success" },
];

export const modelStream = [
  ...chunkStream.slice(0, -1),
  {
    type: "result",
    status: "success",
    stats: {
      total_tokens: 1_650_000,
      input_tokens: 1_500_000,
      output_tokens: 150_000,
      cached: 500_000,
      input: 1_000_000,
      duration_ms: 1000,
      tool_calls: 1,
      models: {
        "gemini-test-pro": {
          total_tokens: 1_100_000,
          input_tokens: 1_000_000,
          output_tokens: 100_000,
          cached: 400_000,
          input: 600_000,
        },
        "gemini-test-flash": {
          total_tokens: 550_000,
          input_tokens: 500_000,
          output_tokens: 50_000,
          cached: 100_000,
          input: 400_000,
        },
      },
    },
  },
];

export const modelUsage = [
  {
    model: "gemini-test-pro",
    usage: {
      input_tokens: 1_000_000,
      cache_read_input_tokens: 400_000,
      output_tokens: 100_000,
    },
  },
  {
    model: "gemini-test-flash",
    usage: {
      input_tokens: 500_000,
      cache_read_input_tokens: 100_000,
      output_tokens: 50_000,
    },
  },
];

export function fakeGemini(
  scene: Scene,
  options: {
    readonly events?: readonly unknown[];
    readonly exitCode?: number;
  } = {},
): string {
  const program = join(scene.directory, "gemini");
  const stream = (options.events ?? chunkStream)
    .map((event) => JSON.stringify(event))
    .join("\n");
  writeFileSync(
    program,
    `#!${process.execPath}
import { execFileSync } from "node:child_process";
import { writeFileSync, readdirSync } from "node:fs";
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;
writeFileSync(${JSON.stringify(join(scene.directory, "gemini-observed.json"))}, JSON.stringify({arguments:process.argv.slice(2), stdin, directory:process.cwd(), tokens:Object.keys(process.env).filter((key) => /^(GH|GITHUB)(_ENTERPRISE)?_TOKEN$/.test(key)), configuration:readdirSync(process.env.GH_CONFIG_DIR)}));
writeFileSync("HELLO.md", "Hello.\\n");
execFileSync("git", ["add", "HELLO.md"]);
execFileSync("git", ["commit", "--quiet", "-m", "Add hello"]);
process.stdout.write(${JSON.stringify(stream)});
process.exitCode = ${String(options.exitCode ?? 0)};
`,
    { mode: 0o700 },
  );
  return program;
}
