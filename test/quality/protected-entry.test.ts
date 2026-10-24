import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { format } from "prettier";
import { testMilliseconds } from "../test-timing.ts";
import { withFiles } from "./files-fixture.ts";

await test("QG-09 fixed source checker applies installed policy despite candidate package scripts", async () => {
  await withFiles(
    {
      "src/workflows.ts": "export const value = 1;\n",
      "tsconfig.json": await readFile("tsconfig.json", "utf8"),
      "tsconfig.build.json": await readFile("tsconfig.build.json", "utf8"),
      "package.json": '{"type":"module","scripts":{"check":"exit 0"}}',
    },
    async (directory) => {
      const run = () =>
        spawnSync(
          process.execPath,
          [resolve("tools/check-protected-quality.ts"), directory],
          { encoding: "utf8", timeout: testMilliseconds(15_000) },
        );
      const valid = run();
      assert.equal(valid.status, 0, valid.stderr);
      assert.match(valid.stdout, /"kind": "static-analysis"/);
      assert.doesNotMatch(valid.stdout, /"tests"/);
      await writeFile(
        join(directory, "src/workflows.ts"),
        await format(
          "export function invalid(value: boolean): boolean { return value; }",
          { parser: "typescript" },
        ),
      );
      const invalid = run();
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /no-boolean-parameter/);
      await writeFile(
        join(directory, "tsconfig.json"),
        '{"compilerOptions":{"strict":false},"include":[]}',
      );
      const changed = run();
      assert.equal(changed.status, 1);
      assert.match(changed.stderr, /unadmitted-compiler-configuration/);
    },
  );
});

await test("QG-19 fixed source checker binds candidate product files only under automatic roles", async () => {
  const proposal = (role: string): string =>
    JSON.stringify({
      roles: { "src/admission.ts": role, "test/admission.test.ts": "test" },
    });
  await withFiles(
    {
      "src/workflows.ts": "export const value = 1;\n",
      "src/admission.ts": await format(
        "export function admitted(value: number): number { return value + 1; }",
        { parser: "typescript" },
      ),
      "test/admission.test.ts": await format(
        'import assert from "node:assert/strict"; import { test } from "node:test"; import { admitted } from "../src/admission.ts"; await test("QG-19 admitted adds one", () => { assert.equal(admitted(1), 2); });',
        { parser: "typescript" },
      ),
      "quality/module-policy.json": proposal("pure"),
      "tsconfig.json": await readFile("tsconfig.json", "utf8"),
      "tsconfig.build.json": await readFile("tsconfig.build.json", "utf8"),
      "package.json": '{"type":"module"}',
    },
    async (directory) => {
      const run = () =>
        spawnSync(
          process.execPath,
          [resolve("tools/check-protected-quality.ts"), directory],
          { encoding: "utf8", timeout: testMilliseconds(15_000) },
        );
      const valid = run();
      assert.equal(valid.status, 0, valid.stderr);
      await writeFile(
        join(directory, "quality/module-policy.json"),
        proposal("quality"),
      );
      const reviewed = run();
      assert.equal(reviewed.status, 1);
      assert.match(reviewed.stderr, /mapping-requires-review/);
    },
  );
});
