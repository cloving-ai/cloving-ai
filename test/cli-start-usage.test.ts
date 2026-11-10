import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commandUsage } from "../src/cli/usage.ts";
import {
  defaultCommand,
  defaultCodexCommand,
} from "../src/harness-defaults.ts";

await test("CLV-201 start help supports an installed package without a checkout", () => {
  assert.doesNotMatch(String(commandUsage["start"]), /development checkout/);
});

await test("CLV-228 queue guidance requires a declared queue workflow", () => {
  const help = String(commandUsage["start"])
    .split("\n")
    .find((line) => line.trim().startsWith("CLOVING_QUEUE_SECONDS"));
  assert.ok(help);
  assert.match(help, /declared workflow.*queue: true/);
  assert.match(help, /no queue workflow.*no queue/);
  assert.doesNotMatch(help, /develop-issue/);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const queue = readme
    .split("\n")
    .find((line) => line.startsWith("Set `CLOVING_QUEUE_SECONDS`"));
  assert.ok(queue);
  assert.match(queue, /no workflow declares it, no queue starts/);
  assert.doesNotMatch(queue, /bundled|develop-issue/);
});

const program = [
  "../src/harness-defaults.ts",
  "project-configuration.ts",
  "self-host.ts",
  "self-host-processes.ts",
  "self-host-children.ts",
  "self-host-queue.ts",
]
  .map((file) =>
    readFileSync(join(import.meta.dirname, "../tools", file), "utf8"),
  )
  .join("\n");

const facts: readonly (readonly [string, RegExp])[] = [
  [
    "CLOVING_SELF_UPDATE_SECONDS",
    /30.*3600.*stops the daemon.*package-lock.json.*operator/,
  ],
  ["CLOVING_TICKET_COMMAND", /JSON list/],
  ["CLOVING_QUEUE_LANES", /1.*16.*default is 1.*CLOVING_QUEUE_SECONDS/],
  [
    "CLOVING_QUEUE_WORKING_LANES",
    /1.*16.*CLOVING_QUEUE_LANES.*turn or a command.*CI, a review or a person.*default is CLOVING_QUEUE_LANES.*cloving reload/,
  ],
  [
    "CLOVING_QUEUE_MAX_LOAD_PER_CORE",
    /0\.1.*4.*default is 0\.7.*1-minute load average.*cores.*cloving reload/,
  ],
  [
    "CLOVING_QUEUE_MAX_MEMORY_PRESSURE",
    /normal or warn.*default is normal.*sysctl.*MemAvailable.*cloving reload/,
  ],
  [
    "CLOVING_QUEUE_DAILY_SPEND_USD",
    /positive finite.*USD.*CLOVING_QUEUE_SECONDS.*85 percent.*24 hours.*no spend limit/,
  ],
  [
    "CLOVING_SCHEDULES",
    /JSON object.*everySeconds.*input.*at.*timeZone.*weekdays.*60.*2592000.*HH:MM.*IANA.*Unset keeps declaration schedules.*skip.*restart/,
  ],
  ["CLOVING_NOTIFY_COMMAND", /JSON list.*standard input.*no default/],
  [
    "CLOVING_QUEUE_SECONDS",
    /10.*3600.*CLOVING_NEXT_COMMAND.*CLOVING_TICKET_COMMAND.*no queue.*manual.*workflow-active/,
  ],
  [
    "CLOVING_NEXT_COMMAND",
    /JSON list .*no added argument.*ticket ID.*no default/,
  ],
  [
    "CLOVING_READY_COMMAND",
    /JSON list .*Requires CLOVING_QUEUE_SECONDS.*queue starts.*one queue interval after each run ends.*no added argument.*JSON list of the ready tickets.*Queue checks do not wait.*id.*readyAt UTC time.*watch page.*not in work.*dependency.*oldest wait.*no default/,
  ],
  ["CLOVING_CLAUDE_COMMAND", /JSON list/],
  [
    "CLOVING_GROK_COMMAND",
    /JSON list.*streaming-messages-json.*--always-approve.*-p/,
  ],
  ["CLOVING_PROFILES", /JSON file.*profile.*cloving reload.*no default/],
  ["CLOVING_COMMANDS", /JSON object.*absolute.*invalid-commands.*no commands/],
  [
    "CLOVING_COMMAND_SECONDS",
    /1.*3600.*default is 60.*invalid-command-seconds/,
  ],
  ["CLOVING_TOKEN_PRICES", /JSON object.*million tokens.*override.*built-in/],
  [
    "CLOVING_FALLBACK_MODELS",
    /JSON array.*three.*nonempty.*no fallback.*higher price/,
  ],
  ["CLOVING_WORKER", /claude.*codex.*gemini.*grok.*default is claude/],
  ["CLOVING_CODEX_COMMAND", /JSON list.*codex exec.*no sandbox/],
  [
    "CLOVING_GEMINI_COMMAND",
    /JSON list.*gemini --output-format stream-json --approval-mode yolo.*-p.*No approval prompts or capacity retries/,
  ],
  [
    "CLOVING_OPENCODE_COMMAND",
    /JSON list.*opencode run --format json.*one argument.*OPENCODE_PERMISSION/,
  ],
  [
    "CLOVING_WATCH_REPOSITORY",
    /service repository.*local origin.*current-directory default/,
  ],
  ["CLOVING_WATCH_PORT", /The value off .* The default is 3663\./],
  ["CLOVING_PHONE_RELAY", /phone relay.*The value off .*The default is on\./],
  ["CLOVING_OWNERSHIP_LEASE_SECONDS", /The default is 15\./],
  ["CLOVING_HOST_BOUND", /The default is 8\./],
  ["CLOVING_GH_COMMAND", /JSON list .*pull requests.* The default is gh\./],
  ["CLOVING_CHECK_COMMAND", /JSON list .*before a merge.* no default/],
  [
    "CLOVING_REQUIRED_CHECKS",
    /JSON list .*check run names.*GitHub Actions.*90 minutes/,
  ],
  ["CLOVING_PRIVATE_TEXTS", /JSON list of texts .*home folder.*case/],
  [
    "CLOVING_TURN_ENVIRONMENT",
    /inherit, or a JSON list of variable names\. The default is an empty list\..*login variables of its harness.*one release/,
  ],
  [
    "CLOVING_DEMO_TOOL",
    /absolute path of the instruction file or folder of a demo tool.*private setting demo\.tool.*each turn gets it/,
  ],
  [
    "CLOVING_MERGE_MODE",
    /direct or queue.*default is direct.*merge queue rule/,
  ],
];

await test("CLV-131 start help describes the persistent failure limit and explicit queue recovery", () => {
  const help = String(commandUsage["start"]);
  assert.match(help, /Usage: cloving start .*\[--reset-queue\]/);
  assert.match(help, /three.*runs in a row/);
  assert.match(help, /successful handoff resets the count/);
  assert.match(help, /ordinary restarts preserve the count/);
  assert.match(help, /Stop the service.*--reset-queue.*clear.*failure/);
  assert.equal(help.includes("unsuccessful run until restart"), false);
});

await test("CLV-061 the help text of the start command has one line for each setting that the start program reads, with the form and the default of the setting", () => {
  const lines = String(commandUsage["start"]).split("\n");
  const settingLines = (name: string): readonly string[] =>
    lines.filter((line) => line.startsWith(`  ${name} `));
  const names = [...new Set(program.match(/CLOVING_[A-Z_]+/g))];
  assert.equal(names.length, 38);
  for (const name of names) assert.equal(settingLines(name).length, 1, name);
  for (const [name, fact] of facts)
    assert.match(String(settingLines(name)[0]), fact);
});

await test("CLV-070 run help names next as an input source and explains the reserved ticket ID", () => {
  assert.match(String(commandUsage["run"]), /\| --next \|/);
  assert.match(String(commandUsage["run"]), /--next.*--ticket next/);
});

await test("CLV-083 keeps the Claude command and runs Codex without a sandbox by default", () => {
  assert.deepEqual(defaultCommand, [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch",
    "--max-budget-usd",
    "5",
  ]);
  assert.deepEqual(defaultCodexCommand, [
    "codex",
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-",
  ]);
});

await test("CLV-262 default Claude tools allow web research and help names no bundled workflow", () => {
  const tools =
    defaultCommand[defaultCommand.indexOf("--allowedTools") + 1]?.split(",");
  assert.ok(tools?.includes("WebSearch"));
  assert.ok(tools?.includes("WebFetch"));
  for (const name of ["run", "start"])
    assert.doesNotMatch(
      String(commandUsage[name]),
      /develop-(ticket|issue|prompt|prd)/,
    );
});

await test("CLV-202 start help omits retired analysis settings", () => {
  assert.doesNotMatch(String(commandUsage["start"]), /CLOVING_ANALYSIS_/);
});

await test("the watch and start help texts say the worker, because the worker can be any harness", () => {
  assert.match(
    String(commandUsage["watch"]),
    /the work of the worker and each pending decision/,
  );
  assert.match(String(commandUsage["start"]), /the worker and the watch page/);
});

await test("CLV-286 CLV-328 CLV-335 start help says that CLOVING_WATCH_ACTIONS=off also removes the queue control, the loop controls and the run controls of the watch page", () => {
  const help = String(commandUsage["start"])
    .split("\n")
    .find((line) => line.trim().startsWith("CLOVING_WATCH_ACTIONS"));
  assert.match(
    help ?? "",
    /run form, the queue control, the loop controls, the run controls and their write endpoints/,
  );
});

await test("CLV-312 start help and the README describe a workspace start of several repositories", () => {
  const help = String(commandUsage["start"]);
  assert.match(
    help,
    /^Usage: cloving start \[--repository <directory> \| --workspace\] \[--reset-queue\]$/m,
  );
  assert.match(
    help.replaceAll("\n", " "),
    /--workspace.*<config>\/cloving\/workspace\.json.*"version": 1.*"repositories".*absolute path.*name.*last part of the path.*own daemon, runtime directory and settings.*no watch page.*Control-C stops all repositories.*stops the other repositories/,
  );
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const workspace = readme
    .split("\n")
    .find((line) => line.startsWith("`cloving start --workspace`"));
  assert.match(
    workspace ?? "",
    /<config>\/cloving\/workspace\.json.*own daemon, runtime directory and settings.*no watch page.*Control-C stops all repositories.*stops the other repositories/,
  );
});

await test("CLV-312 the help texts and the README describe the workspace watch page and the workspace status", () => {
  const start = String(commandUsage["start"]).replaceAll("\n", " ");
  assert.match(
    start,
    /no watch page of its own.*one watch page for all repositories on the watch port.*cloving status lists each repository.*--repository <name> selects one/,
  );
  assert.match(
    String(commandUsage["watch"]),
    /^Usage: cloving watch \[--port <n>\] \[--workspace\]$/m,
  );
  assert.match(
    String(commandUsage["watch"]).replaceAll("\n", " "),
    /With --workspace.*each repository of the running workspace.*one group of lines for each repository/,
  );
  assert.match(
    String(commandUsage["status"]).replaceAll("\n", " "),
    /While a workspace runs.*one summary line for each repository.*--repository <name>/,
  );
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const workspace = readme
    .split("\n")
    .find((line) => line.startsWith("`cloving start --workspace`"));
  assert.match(
    workspace ?? "",
    /one watch page for all repositories.*Needs you names the repository.*Today panel.*one row for each repository.*cloving status.*--repository <name>/,
  );
});
