import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { configScene } from "./config-cli-fixture.ts";
import { parseInvocation } from "../src/cli/arguments.ts";

await test("CLV-206 collection settings change as whole JSON maps and reject dictionary subpaths", () => {
  using fixture = configScene();
  fixture.write(fixture.privateFile, {
    version: 1,
    profiles: { checker: { model: "private" } },
  });
  const previous = readFileSync(fixture.privateFile, "utf8");
  for (const field of ["profiles.checker.model", "tokenPrices.custom.input"])
    for (const args of [
      ["get", field],
      ["set", field, "1"],
      ["unset", field],
    ]) {
      const result = fixture.run([...args, "--json"]);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stdout, /unknown-setting/);
    }
  assert.equal(readFileSync(fixture.privateFile, "utf8"), previous);
});

await test("CLV-206 negative JSON values reach schema validation and dash-prefixed text stays text", () => {
  using fixture = configScene();
  const invalid = fixture.run(["set", "queue.lanes", "-1", "--json"]);
  assert.equal(invalid.status, 2);
  assert.match(
    invalid.stdout,
    /invalid-setting: queue.lanes must be from 1 to 4/,
  );
  const text = fixture.run(["set", "harness.path", "-custom", "--json"]);
  assert.equal(text.status, 0, text.stderr);
  assert.deepEqual(fixture.read(fixture.privateFile), {
    version: 1,
    harness: { path: "-custom" },
  });
});

await test("CLV-206 grouping paths are unknown settings consistently for reads and changes", () => {
  using fixture = configScene();
  fixture.write(fixture.project, {
    version: 1,
    checks: { required: ["unit"] },
  });
  const previous = readFileSync(fixture.project, "utf8");
  for (const args of [
    ["get", "checks"],
    ["set", "checks", "{}"],
    ["unset", "checks"],
  ]) {
    const result = fixture.run(args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /unknown-setting: checks/);
  }
  assert.equal(readFileSync(fixture.project, "utf8"), previous);
});

await test("CLV-206 profile environment files resolve to values rather than a pathname", () => {
  using fixture = configScene();
  const profiles = fixture.root + "/profiles.json";
  fixture.write(profiles, { profiles: { checker: { model: "environment" } } });
  fixture.write(fixture.privateFile, {
    version: 1,
    profiles: { checker: { model: "private" } },
  });
  const result = fixture.run(["get", "profiles", "--json"], {
    CLOVING_PROFILES: profiles,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    field: "profiles",
    source: "environment",
    value: { checker: { model: "environment" } },
    hidden: [{ source: "private", value: { checker: { model: "private" } } }],
  });
});

await test("CLV-206 default worker commands follow the selected worker and match startup", () => {
  using fixture = configScene();
  const result = fixture.run(["get", "harness.command", "--json"], {
    CLOVING_WORKER: "codex",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    field: "harness.command",
    source: "default",
    hidden: [],
    value: [
      "codex",
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-",
    ],
  });
  const claude = fixture.run(["get", "harness.command", "--json"]);
  assert.match(claude.stdout, /claude/);
  assert.match(claude.stdout, /max-budget-usd/);
});

await test("CLV-206 malformed configuration is rejected before a command changes either file", () => {
  using fixture = configScene();
  fixture.write(fixture.project, { version: 1, queue: { lanes: 2 } });
  fixture.write(fixture.privateFile, { version: 9 });
  const original = readFileSync(fixture.project, "utf8");
  const result = fixture.run(["set", "queue.lanes", "3", "--json"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /unsupported-config-version/);
  assert.equal(readFileSync(fixture.project, "utf8"), original);
  assert.equal(existsSync(`${fixture.project}.bak`), false);
});

await test("CLV-206 config argument errors and help retain the ordinary CLI contract", () => {
  for (const args of [
    [],
    ["unknown"],
    ["get"],
    ["list", "extra"],
    ["list", "--private"],
    ["set", "queue.lanes"],
    ["get", "queue.lanes", "--wrong"],
  ]) {
    assert.equal(parseInvocation(["config", ...args]).kind, "usage-error");
  }
  assert.deepEqual(parseInvocation(["config", "--help"]), {
    kind: "config-help",
  });
  assert.deepEqual(
    parseInvocation([
      "config",
      "get",
      "queue.lanes",
      "--repository",
      "repo",
      "--json",
    ]),
    {
      kind: "config",
      action: "get",
      field: "queue.lanes",
      private: false,
      json: true,
      repository: "repo",
    },
  );
});
