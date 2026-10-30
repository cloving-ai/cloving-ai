import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { withDoctor } from "./doctor-fixture.ts";
import { initCli } from "./init-fixture.ts";
import { terminalInit } from "./init-terminal-fixture.ts";

await test("CLV-209 terminal init restores a custom default and leaves terminal input attached to the harness", () =>
  withDoctor(async (scene) => {
    const file = await scene.program(
      "My Agent.sh",
      `if (process.argv[2] === "--version") console.log("1.0.0");
else if (process.stdin.isTTY) {
  const { createInterface } = require("node:readline/promises");
  const { writeFileSync } = require("node:fs");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  terminal.question("harness-question: ").then((reply) => {
    terminal.close();
    writeFileSync("terminal.json", JSON.stringify({ args: process.argv.slice(2), reply, tty: [process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY] }));
    process.exit(7);
  });
}`,
    );
    assert.equal(initCli(scene, { arguments: ["--harness", file] }).status, 0);
    const result = await terminalInit(scene);
    assert.deepEqual(result.ended, [7, null], result.stdout + result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.selected, true);
    assert.equal(result.answered, true);
    assert.match(result.stdout, /1\. agent-my-agent-sh/);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(scene.repository, "terminal.json"), "utf8"),
      ),
      {
        args: ["run `cloving init-prompt`"],
        reply: "hello harness",
        tty: [true, true, true],
      },
    );
  }));
