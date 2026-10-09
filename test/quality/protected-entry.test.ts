import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { format } from "prettier";
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
          { encoding: "utf8", timeout: 15000 },
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
