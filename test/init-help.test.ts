import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { withProject } from "./cli-fixture.ts";

await test("CLV-209 init help documents selection without requiring a repository", () =>
  withProject({}, (cli) => {
    const result = cli(["init", "--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cloving init.*--harness/);
    assert.match(result.stdout, /shell:<name>/);
    assert.match(cli(["--help"]).stdout, /^ {2}init\s+Start the setup agent/m);
    for (const [argumentsList, code] of [
      [["init", "--harness"], "missing-value"],
      [["init", "extra"], "unexpected-argument"],
      [["init", "--json"], "unexpected-option"],
      [["init", "--port", "1"], "unexpected-option"],
    ] as const) {
      const invalid = cli(argumentsList);
      assert.equal(invalid.status, 2);
      assert.match(invalid.stderr, new RegExp(code));
    }
  }));

await test("CLV-209 README First run starts with init and replaces the manual setup prompt", async () => {
  const text = await readFile("README.md", "utf8");
  assert.doesNotMatch(text, /Set up Cloving for a repository/);
  assert.match(text, /## First run\n\n```sh\ncloving init\n```/);
});
