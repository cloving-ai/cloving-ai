import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commandUsage } from "../src/cli/usage.ts";

const program = readFileSync(
  join(import.meta.dirname, "../tools/self-host.ts"),
  "utf8",
);

const facts: readonly (readonly [string, RegExp])[] = [
  ["CLOVING_TICKET_COMMAND", /JSON list/],
  [
    "CLOVING_NEXT_COMMAND",
    /JSON list .*no added argument.*ticket ID.*no default/,
  ],
  ["CLOVING_CLAUDE_COMMAND", /JSON list/],
  ["CLOVING_WATCH_PORT", /The value off .* The default is 3663\./],
  ["CLOVING_OWNERSHIP_LEASE_SECONDS", /The default is 15\./],
  ["CLOVING_HOST_BOUND", /The default is 8\./],
  ["CLOVING_GH_COMMAND", /JSON list .*pull requests.* The default is gh\./],
  ["CLOVING_CHECK_COMMAND", /JSON list .*before a merge.* no default/],
  ["CLOVING_PRIVATE_TEXTS", /JSON list of texts .*home folder.*case/],
];

await test("CLV-061 the help text of the start command has one line for each setting that the start program reads, with the form and the default of the setting", () => {
  const lines = String(commandUsage["start"]).split("\n");
  const settingLines = (name: string): readonly string[] =>
    lines.filter((line) => line.startsWith(`  ${name} `));
  const names = [...new Set(program.match(/CLOVING_[A-Z_]+/g))];
  assert.equal(names.length, 10);
  for (const name of names) assert.equal(settingLines(name).length, 1, name);
  for (const [name, fact] of facts)
    assert.match(String(settingLines(name)[0]), fact);
});

await test("CLV-070 run help names next as an input source and explains the reserved ticket ID", () => {
  assert.match(String(commandUsage["run"]), /\| --next \|/);
  assert.match(String(commandUsage["run"]), /--next.*--ticket next/);
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
