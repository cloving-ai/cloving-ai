import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import * as workflows from "../src/workflows.ts";

for (const argumentsList of [[], ["--help"], ["-h"]]) {
  await test(`scaffold explains available commands: ${JSON.stringify(argumentsList)}`, () => {
    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), ...argumentsList],
      { encoding: "utf8", timeout: 5000 },
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
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "0.4.0\n");
  });
}

await test("scaffold rejects unknown commands and exposes only implemented helpers", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("src/cli.ts"), "--unknown"],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERR_PARSE_ARGS_UNKNOWN_OPTION/);
  assert.deepEqual(Object.keys(workflows), []);
});
