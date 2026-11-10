import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const readme = readFileSync(join(import.meta.dirname, "../README.md"), "utf8");

await test("the README documents the Linux shards of a pull request and of main", () => {
  assert.match(
    readme,
    /A pull request runs six duration-balanced Linux shards on Node 26\.9\.0\. A push to `main` runs three shards on each supported Node version\./,
  );
  assert.match(
    readme,
    /On a push to `main`, CI also runs the Ubuntu checks with Node 24\.22\.1\./,
  );
  assert.doesNotMatch(
    readme,
    /three duration-balanced shards for each Linux Node version on each pull request/,
  );
});
