import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { parseCheckTimeFactor } from "../quality/test-execution.ts";
import * as workflows from "../src/workflows.ts";
import { packageVersion } from "./release-fixture.ts";

const timeFactor = parseCheckTimeFactor(
  process.env["CLOVING_CHECK_TIME_FACTOR"],
);

for (const argumentsList of [[], ["--help"], ["-h"]]) {
  await test(`scaffold explains available commands: ${JSON.stringify(argumentsList)}`, () => {
    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), ...argumentsList],
      { encoding: "utf8", timeout: 5000 * timeFactor },
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: cloving \[--help\] \[--version\]/);
  });
}

for (const argument of ["--version", "-v"]) {
  await test(`scaffold starts at the next npm version: ${argument}`, () => {
    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), argument],
      { encoding: "utf8", timeout: 5000 * timeFactor },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${packageVersion}\n`);
  });
}

await test("scaffold rejects unknown commands and exposes only implemented helpers", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("src/cli.ts"), "--unknown"],
    { encoding: "utf8", timeout: 5000 * timeFactor },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown-option/);
  assert.deepEqual(Object.keys(workflows), [
    "decisionGate",
    "handoff",
    "loadCycle",
    "protectedEffect",
    "reviewByPerson",
    "runCommand",
    "sleep",
    "ticketStatus",
    "waitForDecision",
    "waitForRun",
  ]);
});

await test("CLV-142 scales the scaffold and fake effect worker subprocess limits", () => {
  const probe = `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const spawn = childProcess.spawnSync;
childProcess.spawnSync = (...argumentsList) => {
  const timeout = argumentsList[2]?.timeout;
  if (timeout !== 15000) throw new Error("expected a 15000 millisecond subprocess limit, got " + timeout);
  process.stdout.write("CLV-142 scaled subprocess limit\\n");
  return spawn(...argumentsList);
};
syncBuiltinESMExports();
`;
  for (const scenario of [
    { file: "test/scaffold.test.ts", pattern: "^scaffold", calls: 6 },
    {
      file: "test/effect-launch.test.ts",
      pattern: "CLV-049 the fake worker",
      calls: 1,
    },
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(probe)}`,
        "--test",
        `--test-name-pattern=${scenario.pattern}`,
        scenario.file,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_TEST_CONTEXT: undefined,
          CLOVING_CHECK_TIME_FACTOR: "3",
        },
        timeout: (scenario.calls * 15000 + 10000) * timeFactor,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(
      result.stdout.match(/CLV-142 scaled subprocess limit/g)?.length,
      scenario.calls,
      result.stdout + result.stderr,
    );
  }
});

for (const factor of ["1", "3"])
  await test(`CLV-142 the enclosing probe budgets sequential calls at factor ${factor}`, () => {
    const probe = `
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const spawn = childProcess.spawnSync;
childProcess.spawnSync = (...argumentsList) => {
  const calls = argumentsList[1].at(-1) === "test/scaffold.test.ts" ? 6 : 1;
  const minimum = (calls * 15000 + 10000) * Number(process.env.CLOVING_CHECK_TIME_FACTOR);
  const timeout = argumentsList[2]?.timeout;
  assert.ok(timeout >= minimum, "enclosing probe timeout " + timeout + " is below " + minimum);
  process.stdout.write("CLV-142 enclosing probe limit\\n");
  return spawn(...argumentsList);
};
syncBuiltinESMExports();
`;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(probe)}`,
        "--test",
        "--test-name-pattern=CLV-142 scales the scaffold",
        "test/scaffold.test.ts",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_TEST_CONTEXT: undefined,
          CLOVING_CHECK_TIME_FACTOR: factor,
        },
        timeout: 150000 * Number(factor),
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(
      result.stdout.match(/CLV-142 enclosing probe limit/g)?.length,
      2,
      result.stdout + result.stderr,
    );
  });
