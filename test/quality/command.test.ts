import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../../quality/command.ts";

const command = {
  executable: process.execPath,
  directory: process.cwd(),
  timeoutMilliseconds: 1000,
};

await test("QG-10 reports actual successful command output", () => {
  assert.equal(
    runCommand({
      ...command,
      arguments: ["-e", "process.stdout.write('verified')"],
    }),
    "verified",
  );
});

for (const scenario of [
  {
    name: "missing tool",
    options: { ...command, executable: "/not-a-cloving-tool", arguments: [] },
    message: /execution failed/,
  },
  {
    name: "nonzero exit",
    options: { ...command, arguments: ["-e", "process.exitCode = 7"] },
    message: /exit 7/,
  },
  {
    name: "timeout",
    options: {
      ...command,
      timeoutMilliseconds: 50,
      arguments: ["-e", "setInterval(() => {}, 1000)"],
    },
    message: /execution failed/,
  },
]) {
  await test(`QG-10 rejects ${scenario.name}`, () => {
    assert.throws(() => runCommand(scenario.options), scenario.message);
  });
}
