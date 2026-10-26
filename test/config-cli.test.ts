import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { configScene } from "./config-cli-fixture.ts";

await test("CLV-206 config set writes the before-merge command only to the project file", () => {
  using fixture = configScene();
  try {
    const result = fixture.run(["set", "checks.beforeMerge", '["npm","test"]']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(fixture.read(fixture.project), {
      version: 1,
      checks: { beforeMerge: ["npm", "test"] },
    });
    assert.equal(existsSync(fixture.privateFile), false);
    assert.equal(existsSync(`${fixture.project}.bak`), false);
  } finally {
    fixture.close();
  }
});

await test("CLV-206 private settings and explicit overrides use only the private file with backups", () => {
  using fixture = configScene();
  assert.equal(
    fixture.run(["set", "privateTexts", '["acme"]', "--json"]).status,
    0,
  );
  assert.equal(existsSync(fixture.project), false);
  assert.equal(existsSync(`${fixture.privateFile}.bak`), false);
  const original = readFileSync(fixture.privateFile, "utf8");
  assert.equal(
    fixture.run(["set", "checks.required", '["unit"]', "--private"]).status,
    0,
  );
  assert.equal(readFileSync(`${fixture.privateFile}.bak`, "utf8"), original);
  assert.equal(statSync(fixture.privateFile).mode & 0o777, 0o600);
  assert.equal(statSync(`${fixture.privateFile}.bak`).mode & 0o777, 0o600);
  assert.equal(
    fixture.run(["unset", "checks.required", "--private", "--json"]).status,
    0,
  );
  assert.deepEqual(fixture.read(fixture.privateFile), {
    version: 1,
    privateTexts: ["acme"],
  });
});

await test("CLV-206 invalid settings and unknown fields exit 2 without changing files", () => {
  using fixture = configScene();
  fixture.write(fixture.project, { version: 1, queue: { lanes: 2 } });
  const original = readFileSync(fixture.project, "utf8");
  for (const args of [
    ["set", "queue.lanes", "9"],
    ["set", "queue.lanes", '"2"', "--json"],
    ["get", "unknown.field", "--json"],
    ["unset", "queue.unknown"],
    ["set", "__proto__.polluted", "true"],
  ]) {
    const result = fixture.run(args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(
      result.stdout + result.stderr,
      /invalid-setting|unknown-setting/,
    );
  }
  assert.match(
    fixture.run(["set", "queue.lanes", "9"]).stderr,
    /invalid-setting: queue.lanes must be from 1 to 4/,
  );
  assert.equal(readFileSync(fixture.project, "utf8"), original);
  assert.equal(existsSync(`${fixture.project}.bak`), false);
});

await test("CLV-206 list and get report values, defaults, and every hidden source", () => {
  using fixture = configScene();
  fixture.write(fixture.project, {
    version: 1,
    checks: { beforeMerge: ["project"] },
  });
  fixture.write(fixture.privateFile, {
    version: 1,
    checks: { beforeMerge: ["private"] },
  });
  const result = fixture.run(["list", "--json"], {
    CLOVING_CHECK_COMMAND: '["environment"]',
  });
  assert.equal(result.status, 0, result.stderr);
  const listed: unknown = JSON.parse(result.stdout);
  assert.ok(listed && typeof listed === "object" && "settings" in listed);
  assert.ok(Array.isArray(listed.settings));
  assert.deepEqual(
    listed.settings.find(
      (item: { field: string }) => item.field === "checks.beforeMerge",
    ),
    {
      field: "checks.beforeMerge",
      value: ["environment"],
      source: "environment",
      hidden: [
        { value: ["private"], source: "private" },
        { value: ["project"], source: "project" },
      ],
    },
  );
  const get = fixture.run(["get", "queue.lanes", "--json"]);
  assert.equal(get.status, 0, get.stderr);
  assert.deepEqual(JSON.parse(get.stdout), {
    schemaVersion: 1,
    field: "queue.lanes",
    value: 1,
    source: "default",
    hidden: [],
  });
  assert.match(fixture.run(["get", "checks.beforeMerge"]).stdout, /private/);
  assert.match(fixture.run(["list"]).stdout, /queue.lanes.*default/);
});

await test("CLV-206 unset keeps unrelated settings and backups preserve the previous bytes", () => {
  using fixture = configScene();
  fixture.write(fixture.project, {
    version: 1,
    checks: { beforeMerge: ["check"], required: ["unit"] },
    queue: { lanes: 2 },
  });
  const original = readFileSync(fixture.project, "utf8");
  assert.equal(fixture.run(["unset", "checks.beforeMerge"]).status, 0);
  assert.equal(readFileSync(`${fixture.project}.bak`, "utf8"), original);
  assert.deepEqual(fixture.read(fixture.project), {
    version: 1,
    checks: { required: ["unit"] },
    queue: { lanes: 2 },
  });
});

for (const action of ["set", "unset"])
  for (const [field, value, expected] of [
    ["name", "codex", action === "set" ? { name: "codex" } : undefined],
    [
      "kind",
      "shell",
      action === "set" ? { name: "claude", kind: "shell" } : { name: "claude" },
    ],
    [
      "path",
      "agent",
      action === "set"
        ? { name: "claude", kind: "file", path: "agent" }
        : { name: "claude", kind: "file" },
    ],
  ] as const)
    await test(`CLV-206 ${action} harness.${field} clears its dependent fields`, () => {
      using fixture = configScene();
      fixture.write(fixture.privateFile, {
        version: 1,
        harness: {
          name: "claude",
          kind: "file",
          path: "old",
          command: ["old"],
        },
        privateTexts: ["keep"],
      });
      const args = [
        action,
        `harness.${field}`,
        ...(action === "set" ? [value] : []),
      ];
      const result = fixture.run(args);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(fixture.read(fixture.privateFile), {
        version: 1,
        ...(expected === undefined ? {} : { harness: expected }),
        privateTexts: ["keep"],
      });
    });
