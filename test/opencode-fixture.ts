import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scene } from "./claude-worker-fixture.ts";

export const opencodeReport =
  "Implemented the change.\nTicket status: complete";

export const opencodeEvents = [
  { type: "step_start", sessionID: "session-1", part: { type: "step-start" } },
  {
    type: "text",
    sessionID: "session-1",
    part: { type: "text", text: "Working.", time: { start: 1, end: 2 } },
  },
  {
    type: "step_finish",
    sessionID: "session-1",
    part: {
      type: "step-finish",
      reason: "tool-calls",
      cost: 0.1,
      tokens: {
        input: 100,
        output: 20,
        reasoning: 5,
        cache: { read: 40, write: 0 },
      },
    },
  },
  { type: "step_start", sessionID: "session-1", part: { type: "step-start" } },
  {
    type: "text",
    sessionID: "session-1",
    part: { type: "text", text: opencodeReport, time: { start: 3, end: 4 } },
  },
  {
    type: "step_finish",
    sessionID: "session-1",
    part: {
      type: "step-finish",
      reason: "stop",
      cost: 0.2,
      tokens: {
        input: 200,
        output: 30,
        reasoning: 7,
        cache: { read: 60, write: 0 },
      },
    },
  },
];

export function fakeOpencode(
  scene: Pick<Scene, "directory">,
  options: {
    readonly events?: readonly unknown[];
    readonly exitCode?: number;
    readonly stderr?: string;
  } = {},
): string {
  const path = join(scene.directory, "opencode");
  const output = (options.events ?? opencodeEvents)
    .map((event) => JSON.stringify(event))
    .join("\n");
  writeFileSync(
    path,
    `#!${process.execPath}
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
let stdin = "";
for await (const chunk of process.stdin) stdin += String(chunk);
const observed = { arguments: process.argv.slice(2), stdin, directory: process.cwd(), environment: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(GH_|GITHUB_|OPENCODE_PERMISSION)/.test(name))), configurationFiles: readdirSync(process.env.GH_CONFIG_DIR) };
writeFileSync(${JSON.stringify(join(scene.directory, "observed.json"))}, JSON.stringify(observed));
writeFileSync("opencode-work.txt", "Changed by opencode.");
execFileSync("git", ["add", "opencode-work.txt"]);
execFileSync("git", ["-c", "user.name=Worker", "-c", "user.email=worker@example.invalid", "commit", "-m", "Add opencode work"], { stdio: "ignore" });
process.stdout.write(${JSON.stringify(output)});
process.stderr.write(${JSON.stringify(options.stderr ?? "")});
process.exitCode = ${String(options.exitCode ?? 0)};
`,
    { mode: 0o700 },
  );
  return path;
}
