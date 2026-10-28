import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { configScene } from "./config-cli-fixture.ts";
import { parseInvocation } from "../src/cli/arguments.ts";
import { parseTokenPrices } from "../src/token-prices.ts";
import { settingValue } from "../src/configuration-change.ts";

await test("CLV-206 setting values narrow to finite JSON data or plain text", () => {
  for (const [text, expected] of [
    [
      '{"nested":[null,true,false,2,"text"]}',
      { nested: [null, true, false, 2, "text"] },
    ],
    ["null", null],
    ["plain text", "plain text"],
  ] as const)
    assert.deepEqual(settingValue(text), expected);
  for (const text of ["1e400", "[1e400]", '{"input":1e400}'])
    assert.throws(() => settingValue(text), /invalid-setting-value/);
});

for (const source of ["private", "environment"] as const)
  await test(`CLV-206 ${source} token prices include built-in models in get and list`, () => {
    using fixture = configScene();
    const saved = { custom: { input: 3, cachedInput: 1, output: 8 } };
    const override = {
      "gpt-6.1-sol": { input: 5, cachedInput: 2, output: 9 },
    };
    fixture.write(fixture.privateFile, { version: 1, tokenPrices: saved });
    const environment =
      source === "environment"
        ? { CLOVING_TOKEN_PRICES: JSON.stringify(override) }
        : {};
    const expected = {
      field: "tokenPrices",
      source,
      value: parseTokenPrices(
        JSON.stringify(source === "environment" ? override : saved),
      ),
      hidden:
        source === "environment" ? [{ source: "private", value: saved }] : [],
    };
    const get = fixture.run(["get", "tokenPrices", "--json"], environment);
    assert.equal(get.status, 0, get.stderr);
    assert.deepEqual(JSON.parse(get.stdout), {
      schemaVersion: 1,
      ...expected,
    });
    const list = fixture.run(["list", "--json"], environment);
    assert.equal(list.status, 0, list.stderr);
    const listed: unknown = JSON.parse(list.stdout);
    assert.ok(listed && typeof listed === "object" && "settings" in listed);
    assert.ok(Array.isArray(listed.settings));
    assert.deepEqual(
      listed.settings.find(
        (item: { field: string }) => item.field === "tokenPrices",
      ),
      expected,
    );
  });

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

await test("CLV-211 config shows the Gemini default and its own command override", () => {
  using fixture = configScene();
  fixture.write(fixture.privateFile, {
    version: 1,
    harness: { name: "gemini" },
  });
  const result = fixture.run(["get", "harness.command", "--json"], {
    CLOVING_CLAUDE_COMMAND: '["unrelated-claude"]',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    field: "harness.command",
    source: "default",
    hidden: [],
    value: [
      "gemini",
      "--output-format",
      "stream-json",
      "--approval-mode",
      "yolo",
    ],
  });
  const overridden = fixture.run(["get", "harness.command", "--json"], {
    CLOVING_GEMINI_COMMAND: '["custom-gemini"]',
  });
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.deepEqual(JSON.parse(overridden.stdout), {
    schemaVersion: 1,
    field: "harness.command",
    source: "environment",
    hidden: [],
    value: ["custom-gemini"],
  });
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
