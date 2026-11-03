import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { commandUsage } from "../src/cli/usage.ts";
import { configScene } from "./config-cli-fixture.ts";

await test("CLV-270 start help has one line for each retention variable with its form and default", () => {
  const lines = String(commandUsage["start"]).split("\n");
  for (const [name, fact] of [
    [
      "CLOVING_RETENTION_DAYS",
      /at least 1.*null.*default is 30.*completed, failed or cancelled.*never.*not finished.*null keeps all records.*each hour.*200/,
    ],
    ["CLOVING_RETENTION_ACTION", /archive or delete.*default is archive/],
    [
      "CLOVING_RETENTION_ARCHIVE_FOLDER",
      /absolute.*null.*<state>\/archive.*another volume.*not available.*moves nothing/,
    ],
  ] as const) {
    const found = lines.filter((line) => line.startsWith(`  ${name} `));
    assert.equal(found.length, 1, name);
    assert.match(String(found[0]), fact);
  }
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(
    readme,
    /`retention\.days`, `retention\.action` and `retention\.archiveFolder`/,
  );
});

await test("CLV-270 config set keeps the retention settings only in the private file", () => {
  using fixture = configScene();
  for (const [field, value] of [
    ["retention.days", "null"],
    ["retention.action", "delete"],
    ["retention.archiveFolder", "/srv/archive"],
  ] as const) {
    const result = fixture.run(["set", field, value]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.deepEqual(fixture.read(fixture.privateFile), {
    version: 1,
    retention: { days: null, action: "delete", archiveFolder: "/srv/archive" },
  });
  assert.equal(existsSync(fixture.project), false);
  const refused = fixture.run(["set", "retention.days", "0"]);
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /invalid-setting: retention.days/);
});
