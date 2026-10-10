import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { checkTests } from "../../quality/test-execution.ts";
import { withFiles } from "./files-fixture.ts";

async function rejectSource(source: (file: string) => string): Promise<void> {
  await withFiles(
    {
      "package.json": '{"type":"module"}',
      "main.test.ts":
        'import { test } from "node:test"; import assert from "node:assert/strict"; import { value } from "./main.ts"; await test("value", () => { assert.equal(value, 1); });',
    },
    async (directory) => {
      const file = join(directory, "main.ts");
      await writeFile(file, source(file));
      assert.throws(() => {
        checkTests(directory, {
          files: [join(directory, "main.test.ts")],
          coverageFiles: [file],
        });
      }, /unadmitted-coverage-directive/);
    },
  );
}

await test("QG-18 rejects provider source-map hints embedded inside template literals", async () => {
  await rejectSource((file) => {
    const map = {
      version: 3,
      sources: [file],
      sourcesContent: ["export const value = 1;"],
      names: [],
      mappings: "AAAA",
    };
    const encoded = Buffer.from(JSON.stringify(map)).toString("base64");
    return `export const value = 1;\nexport function neverCalled() { return 2; }\nconst documentation = \`\n# sourceMappingURL=data:application/json;base64,${encoded}\n\`;`;
  });
});

await test("QG-18 rejects provider ignore ranges embedded inside string literals", async () => {
  await rejectSource(
    () =>
      'export const value = 1;\nconst documentation = "/* v8 ignore start */";\nexport function neverCalled() { return 2; }',
  );
});
