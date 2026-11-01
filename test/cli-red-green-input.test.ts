import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { redGreenEntry } from "./red-green-fixture.ts";
import { git } from "./claude-worker-fixture.ts";
import { redGreen, runs, withRedGreen } from "./red-green-fixture.ts";

const passing = {
  red: { status: 0, output: "pass" },
  green: { status: 0, output: "pass" },
};

await test("CLV-248 a hex branch name with the wrong object ID length is refused", () =>
  withRedGreen(passing, (scene) => {
    const name = "a".repeat(64);
    git(scene.repository, ["branch", name, scene.head]);
    const result = redGreen(scene, { input: JSON.stringify({ head: name }) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid-red-green-input.*full commit ID/);
    assert.equal(result.stdout, "");
    assert.deepEqual(runs(scene), []);
  }));

await test("CLV-248 red-green help documents its input and settings without a service", () => {
  const result = spawnSync(
    process.execPath,
    [redGreenEntry, "red-green", "--help"],
    { encoding: "utf8", input: "" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: cloving red-green/);
  assert.match(result.stdout, /CLOVING_RED_GREEN/);
  const help = spawnSync(process.execPath, [redGreenEntry, "--help"], {
    encoding: "utf8",
  });
  assert.match(help.stdout, /red-green/);
});

for (const [name, input] of [
  ["invalid JSON", "{"],
  ["absent head", "{}"],
  ["short commit ID", '{"head":"abcd123"}'],
  ["revision expression", '{"head":"HEAD"}'],
  ["non-object input", "null"],
] as const)
  await test(`CLV-248 refuses ${name} before a test command`, () =>
    withRedGreen(passing, (scene) => {
      const result = redGreen(scene, { input });
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /invalid-red-green-input.*(JSON|full commit ID)/,
      );
      assert.equal(result.stdout, "");
      assert.deepEqual(runs(scene), []);
    }));

await test("CLV-248 refuses unknown origin/HEAD before a test command", () =>
  withRedGreen(passing, (scene) => {
    git(scene.repository, [
      "symbolic-ref",
      "--delete",
      "refs/remotes/origin/HEAD",
    ]);
    const result = redGreen(scene);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /origin\/HEAD/);
    assert.deepEqual(runs(scene), []);
  }));

for (const settings of [
  "{",
  "null",
  "{}",
  '{"test":[],"testFiles":["test/"]}',
  '{"test":["node"],"testFiles":"test/"}',
  '{"test":[4],"testFiles":["test/"]}',
  '{"test":["node"],"testFiles":["test/"],"assertionPattern":"["}',
])
  await test(`CLV-248 refuses invalid CLOVING_RED_GREEN ${settings}`, () =>
    withRedGreen(passing, (scene) => {
      const result = redGreen(scene, {
        environment: { CLOVING_RED_GREEN: settings },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /invalid.*CLOVING_RED_GREEN/);
      assert.equal(result.stdout, "");
      assert.deepEqual(runs(scene), []);
    }));
