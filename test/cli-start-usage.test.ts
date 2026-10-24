import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commandUsage } from "../src/cli/usage.ts";

const program = ["self-host.ts", "self-host-processes.ts"]
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
  ["CLOVING_QUEUE_LANES", /1.*4.*default is 1.*CLOVING_QUEUE_SECONDS/],
  ["CLOVING_NOTIFY_COMMAND", /JSON list.*standard input.*no default/],
  [
    "CLOVING_QUEUE_SECONDS",
    /10.*3600.*CLOVING_NEXT_COMMAND.*CLOVING_TICKET_COMMAND.*no queue.*manual.*workflow-active/,
  ],
  [
    "CLOVING_NEXT_COMMAND",
    /JSON list .*no added argument.*ticket ID.*no default/,
  ],
  ["CLOVING_CLAUDE_COMMAND", /JSON list/],
  [
    "CLOVING_ANALYSIS_TOKEN_COMMAND",
    /JSON list.*10 seconds.*4096.*512.*no default/,
  ],
  ["CLOVING_PROFILES", /JSON file.*profile.*no default/],
  ["CLOVING_TOKEN_PRICES", /JSON object.*million tokens.*override.*built-in/],
  [
    "CLOVING_FALLBACK_MODELS",
    /JSON array.*three.*nonempty.*no fallback.*higher price/,
  ],
  ["CLOVING_WORKER", /claude.*codex.*default is claude/],
  ["CLOVING_CODEX_COMMAND", /JSON list.*codex exec.*no sandbox/],
  [
    "CLOVING_WATCH_REPOSITORY",
    /service repository.*local origin.*current-directory default/,
  ],
  ["CLOVING_WATCH_PORT", /The value off .* The default is 3663\./],
  ["CLOVING_OWNERSHIP_LEASE_SECONDS", /The default is 15\./],
  ["CLOVING_HOST_BOUND", /The default is 8\./],
  ["CLOVING_GH_COMMAND", /JSON list .*pull requests.* The default is gh\./],
  ["CLOVING_CHECK_COMMAND", /JSON list .*before a merge.* no default/],
  [
    "CLOVING_REQUIRED_CHECKS",
    /JSON list .*check run names.*GitHub Actions.*90 minutes/,
  ],
  ["CLOVING_PRIVATE_TEXTS", /JSON list of texts .*home folder.*case/],
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
  assert.equal(names.length, 20);
  for (const name of names) assert.equal(settingLines(name).length, 1, name);
  for (const [name, fact] of facts)
    assert.match(String(settingLines(name)[0]), fact);
});

await test("CLV-070 run help names next as an input source and explains the reserved ticket ID", () => {
  assert.match(String(commandUsage["run"]), /\| --next \|/);
  assert.match(String(commandUsage["run"]), /--next.*--ticket next/);
});

await test("CLV-083 keeps the Claude command and runs Codex without a sandbox by default", () => {
  const argumentsOf = (name: string): string[] =>
    [
      ...(
        program.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))?.[1] ??
        ""
      ).matchAll(/"([^"]*)"/g),
    ].map((match) => match[1] ?? "");
  assert.deepEqual(argumentsOf("defaultCommand"), [
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
  assert.deepEqual(argumentsOf("defaultCodexCommand"), [
    "codex",
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-",
  ]);
});

await test("CLV-075 the default Claude command allows web research and help describes develop-prd", () => {
  const command = program.slice(
    program.indexOf("const defaultCommand"),
    program.indexOf("interface Commands"),
  );
  assert.match(command, /--allowedTools[\s\S]*WebSearch/);
  assert.match(command, /--allowedTools[\s\S]*WebFetch/);
  for (const name of ["CLOVING_PRIVATE_TEXTS", "CLOVING_GH_COMMAND"])
    assert.match(
      String(commandUsage["start"])
        .split("\n")
        .find((line) => line.startsWith(`  ${name} `)) ?? "",
      /develop-prd/,
    );
});
