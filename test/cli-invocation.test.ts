import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import { withProject } from "./cli-fixture.ts";

await test("CLV-008 help lists only the implemented commands", async () => {
  await withProject({}, (cli) => {
    for (const argumentsList of [[], ["--help"]]) {
      const result = cli(argumentsList);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /cloving workflows validate <manifest-path>/);
      assert.doesNotMatch(result.stdout, /not implemented/);
      assert.doesNotMatch(result.stdout, /chats import/);
      assert.doesNotMatch(result.stdout, /\bchats\b/);
      assert.match(result.stdout, /^ {2}run {2,}Submit one run/m);
      assert.match(
        result.stdout,
        /^ {2}doctor {2,}Check repository requirements/m,
      );
      assert.match(
        result.stdout,
        /^ {2}init-prompt\s+Print setup instructions/m,
      );
      assert.doesNotMatch(
        result.stdout,
        /\battach\b|\binit\b(?!-prompt\b)|\bmcp\b|develop-ticket/,
      );
      assert.equal(result.stderr, "");
    }
    const help = cli(["workflows", "validate", "--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--input <json-file>/);
    assert.match(help.stdout, /does not admit a run/);
  });
});

for (const [name, argumentsList, code] of [
  ["an unknown command", ["frobnicate"], "unknown-command"],
  ["the standalone init command", ["init"], "unknown-command"],
  ["a removed chats command", ["chats"], "unknown-command"],
  ["a removed chats import", ["chats", "import"], "unknown-command"],
  [
    "a removed chats import with a file",
    ["chats", "import", "--", "transcript.jsonl"],
    "unknown-command",
  ],
  ["a removed chats redact", ["chats", "redact"], "unknown-command"],
  [
    "a removed chats redact with an import ID",
    ["chats", "redact", "12345678-1234-4123-8123-123456789abc"],
    "unknown-command",
  ],
  [
    "removed chats import help",
    ["chats", "import", "--help"],
    "unknown-command",
  ],
  [
    "removed chats redact help",
    ["chats", "redact", "--help"],
    "unknown-command",
  ],
  ["an unknown option", ["--nope"], "unknown-option"],
  ["a missing manifest path", ["workflows", "validate"], "missing-argument"],
  [
    "an extra positional argument",
    ["workflows", "validate", "a.json", "b.json"],
    "unexpected-argument",
  ],
  [
    "a missing option value",
    ["workflows", "validate", "a.json", "--input"],
    "missing-value",
  ],
  ["an incomplete command", ["workflows"], "unknown-command"],
  ["a top-level input flag", ["--input", "x.json"], "unexpected-option"],
  [
    "a version flag on validation",
    ["workflows", "validate", "m.json", "--version"],
    "unexpected-option",
  ],
] as const)
  await test(`CLV-006 ${name} is an invalid invocation`, async () => {
    await withProject({}, (cli) => {
      const human = cli(argumentsList);
      assert.equal(human.status, 2);
      assert.equal(human.stdout, "");
      assert.match(human.stderr, new RegExp(code));
      const json = cli([...argumentsList, "--json"]);
      assert.equal(json.status, 2);
      assert.deepEqual(JSON.parse(json.stdout), {
        schemaVersion: 1,
        kind: "usage-error",
        code,
      });
    });
  });

await test("CLV-006 a top-level JSON flag without a command is an invalid invocation", async () => {
  await withProject({}, (cli) => {
    const result = cli(["--json"]);
    assert.equal(result.status, 2);
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: 1,
      kind: "usage-error",
      code: "unexpected-option",
    });
  });
});

await test("CLV-006 help, version and validation create no runtime state", async () => {
  await withProject({}, async (cli, directory) => {
    const before = await readdir(directory, { recursive: true });
    cli(["--help"]);
    cli(["--version"]);
    cli(["workflows", "validate", "cloving.workflow.json", "--json"]);
    assert.deepEqual(await readdir(directory, { recursive: true }), before);
  });
});
