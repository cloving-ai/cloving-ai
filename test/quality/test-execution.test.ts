import assert from "node:assert/strict";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runCommand } from "../../quality/command.ts";
import { checkTests, testCommand } from "../../quality/test-execution.ts";
import { withFiles } from "./files-fixture.ts";

await test("QG-10 matches executed test coverage through canonical paths", async () => {
  const source =
    'import { test } from "node:test"; import assert from "node:assert/strict"; await test("value", () => { assert.equal(1, 1); });';
  await withFiles({ "real.test.ts": source }, async (directory) => {
    const alias = join(directory, "alias.test.ts");
    await symlink(join(directory, "real.test.ts"), alias);
    assert.doesNotThrow(() => {
      checkTests(directory, { files: [alias] });
    });
  });
});

for (const skipped of [
  'test.skip("hidden", () => {});',
  'test.todo("unfinished");',
  'test("conditional", { skip: true }, () => {});',
  'test("runtime", (context) => { context.skip(); });',
]) {
  await test(`QG-18 rejects skipped work even beside a passing test: ${skipped}`, async () => {
    const source = `import { test } from "node:test"; await test("passing", () => {}); ${skipped}`;
    await withFiles({ "mixed.test.ts": source }, (directory) => {
      assert.throws(() => {
        checkTests(directory, { files: [join(directory, "mixed.test.ts")] });
      }, /skipped-mandatory-test/);
    });
  });
}

await test("QG-18 requires coverage for every declared production source", async () => {
  const files = {
    "package.json": '{"type":"module"}',
    "main.ts": "export const value = 1;",
    "main.test.ts":
      'import { test } from "node:test"; import assert from "node:assert/strict"; await test("passes", () => { assert.equal(1, 1); });',
  };
  await withFiles(files, (directory) => {
    const inventory = [
      join(directory, "main.ts"),
      join(directory, "main.test.ts"),
    ];
    assert.throws(() => {
      checkTests(directory, {
        files: inventory,
        coverageFiles: [join(directory, "main.ts")],
      });
    }, /missing-production-coverage/);
  });
  files["main.test.ts"] =
    'import { test } from "node:test"; import assert from "node:assert/strict"; import { value } from "./main.ts"; await test("passes", () => { assert.equal(value, 1); });';
  await withFiles(files, (directory) => {
    const inventory = [
      join(directory, "main.ts"),
      join(directory, "main.test.ts"),
    ];
    assert.doesNotThrow(() => {
      checkTests(directory, {
        files: inventory,
        coverageFiles: [join(directory, "main.ts")],
      });
    });
  });
});

await test("QG-18 rejects failing TODO events even when the runner exits successfully", async () => {
  const source =
    'import { test } from "node:test"; import assert from "node:assert/strict"; await test("passing", () => { assert.ok(true); }); await test("unfinished", { todo: true }, () => { assert.fail("failure"); });';
  await withFiles({ "main.test.ts": source }, (directory) => {
    assert.throws(() => {
      checkTests(directory, { files: [join(directory, "main.test.ts")] });
    }, /test-report-failure/);
  });
});

await test("QG-18 compares completed test identities with an external mandatory inventory", async () => {
  const source =
    'import { test } from "node:test"; await test("first", () => {});';
  await withFiles({ "main.test.ts": source }, (directory) => {
    const file = join(directory, "main.test.ts");
    assert.throws(() => {
      checkTests(directory, {
        files: [file],
        requiredTests: { [file]: ["first", "removed"] },
      });
    }, /mandatory-test-inventory-mismatch/);
    assert.doesNotThrow(() => {
      checkTests(directory, {
        files: [file],
        requiredTests: { [file]: ["first"] },
      });
    });
  });
});

await test("QG-18 rejects an unhandled rejection from an otherwise passing test", async () => {
  const source =
    'import { test } from "node:test"; await test("unhandled", () => { void Promise.reject(new Error("unhandled fixture")); });';
  await withFiles({ "main.test.ts": source }, (directory) => {
    assert.throws(() => {
      checkTests(directory, { files: [join(directory, "main.test.ts")] });
    }, /Check exit 1/);
  });
});

await test("CLV-044 the developer gate gives its test command a 300 s bound", () => {
  const command = testCommand("/project", {
    tests: ["/project/main.test.ts"],
  });
  assert.equal(command.timeoutMilliseconds, 300000);
  assert.deepEqual(command.arguments.slice(-1), ["/project/main.test.ts"]);
  assert.equal(command.directory, "/project");
});

await test("CLV-044 a test run that is longer than its bound fails the test command", async () => {
  const source =
    'import { test } from "node:test"; import { setTimeout as delay } from "node:timers/promises"; await test("slow", async () => { await delay(2000); });';
  await withFiles({ "slow.test.ts": source }, (directory) => {
    const command = testCommand(directory, {
      tests: [join(directory, "slow.test.ts")],
    });
    assert.throws(() => {
      runCommand({ ...command, timeoutMilliseconds: 50 });
    }, /execution failed/);
  });
});
