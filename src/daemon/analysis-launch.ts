import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { analysisInstruction } from "../chats/analysis-prompt.ts";
export { analysisInstruction } from "../chats/analysis-prompt.ts";

export const analysisMethod = "run-turn:analyze-chats";

const controls = [
  "--safe-mode",
  "--restricted",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--no-chrome",
  "--no-session-persistence",
];

export function analysisCommand(): readonly string[] {
  return [
    "claude",
    ...controls,
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--tools",
    "",
    "--disallowedTools",
    "mcp__*",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--setting-sources",
    "",
    "--settings",
    '{"disableAllHooks":true}',
    "--permission-prompts",
    "none",
    "--max-turns",
    "1",
    "--max-budget-usd",
    "5",
    "--model",
    "sonnet",
    "--system-prompt",
    analysisInstruction,
  ];
}

export function analysisEnvironment(folder: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"],
    HOME: join(folder, "configuration"),
    CLAUDE_CONFIG_DIR: join(folder, "configuration"),
    TMPDIR: join(folder, "configuration"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

function supportedVersion(line: string): boolean {
  const match = /^2\.(0|[1-9]\d*)\.(0|[1-9]\d*) \(Claude Code\)$/.exec(
    line.trim(),
  );
  if (match?.[1] === undefined || match[2] === undefined) return false;
  const minor = BigInt(match[1]);
  return minor > 1n || (minor === 1n && BigInt(match[2]) >= 302n);
}

export async function analysisAvailable(folder: string): Promise<boolean> {
  const probe = (flag: string) =>
    promisify(execFile)("claude", [flag], {
      cwd: folder,
      env: analysisEnvironment(folder),
      timeout: 5_000,
      maxBuffer: 131_072,
    });
  try {
    const version = await probe("--version");
    if (!supportedVersion(version.stdout)) return false;
    const help = await probe("--help");
    const advertised = new Set(
      help.stdout.match(/--[a-zA-Z][a-zA-Z0-9-]*/g) ?? [],
    );
    return analysisCommand()
      .filter((argument) => argument.startsWith("--"))
      .every((flag) => advertised.has(flag));
  } catch {
    return false;
  }
}
