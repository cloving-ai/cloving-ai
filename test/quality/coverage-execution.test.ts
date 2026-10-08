import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { checkTests } from "../../quality/test-execution.ts";
import { withFiles } from "./files-fixture.ts";

const conditions = Array.from(
  { length: 10 },
  (_, index) => `if (input === ${String(index)}) { value += 1; }`,
).join(" ");
const uncovered = "value += 1; ".repeat(10);
const production = `interface Input { readonly label: string; }\r\n// Position probe: café 𐐀\r\nexport function calculate(input: number): number { let value = 0; ${conditions} if (input === 999) { ${uncovered} } return value; }\r\n`;
const tests =
  'import { test } from "node:test"; import assert from "node:assert/strict"; import { calculate } from "./main.ts"; await test("ordinary branches", () => { for (let input = 0; input < 10; input += 1) assert.equal(calculate(input), 1); });';

await test("QG-18 rejects missed same-line statements despite passing native coverage metrics", async () => {
  await withFiles(
    {
      "package.json": '{"type":"module"}',
      "main.ts": production,
      "main.test.ts": tests,
    },
    (directory) => {
      assert.throws(() => {
        checkTests(directory, [join(directory, "main.test.ts")], {
          coverageFiles: [join(directory, "main.ts")],
        });
      }, /insufficient-production-coverage/);
    },
  );
});

await test("QG-18 merges complementary coverage from isolated test processes", async () => {
  await withFiles(
    {
      "package.json": '{"type":"module"}',
      "main.ts": production,
      "main.test.ts": tests,
      "additional.test.ts":
        'import { test } from "node:test"; import assert from "node:assert/strict"; import { calculate } from "./main.ts"; await test("additional branch", () => { assert.equal(calculate(999), 10); });',
    },
    (directory) => {
      assert.doesNotThrow(() => {
        checkTests(
          directory,
          ["main.test.ts", "additional.test.ts"].map((file) =>
            join(directory, file),
          ),
          {
            coverageFiles: [join(directory, "main.ts")],
          },
        );
      });
    },
  );
});

await test("QG-18 rejects production source rewritten during the test run", async () => {
  await withFiles(
    {
      "package.json": '{"type":"module"}',
      "main.ts": "export const value = 1;",
      "main.test.ts":
        'import { test } from "node:test"; import { writeFileSync } from "node:fs"; import { value } from "./main.ts"; await test("rewrites source", () => { writeFileSync(new URL("main.ts", import.meta.url), "export const value = 2;"); });',
    },
    (directory) => {
      assert.throws(() => {
        checkTests(directory, [join(directory, "main.test.ts")], {
          coverageFiles: [join(directory, "main.ts")],
        });
      }, /test-source-changed/);
    },
  );
});

for (const extension of ["ts", "mts", "cts", "js", "mjs", "cjs"]) {
  await test(`QG-18 measures executed ${extension} source`, async () => {
    const source = ["cts", "cjs"].includes(extension)
      ? "module.exports = function twice(input) { return input * 2; };"
      : "export default function twice(input) { return input * 2; }";
    const name = `main.${extension}`;
    await withFiles(
      {
        "package.json": '{"type":"module"}',
        [name]: source,
        "main.test.ts": `import { test } from "node:test"; import assert from "node:assert/strict"; import twice from "./${name}"; await test("twice", () => { assert.equal(twice(2), 4); });`,
      },
      (directory) => {
        assert.doesNotThrow(() => {
          checkTests(directory, [join(directory, "main.test.ts")], {
            coverageFiles: [join(directory, name)],
          });
        });
      },
    );
  });
}

for (const [comment, diagnostic] of [
  ["//# sourceMappingURL=missing.map", /unadmitted-coverage-directive/],
  ["/* v8 ignore next */", /unapproved-suppression/],
  ["/* istanbul ignore file */", /unapproved-suppression/],
] as const) {
  await test(`QG-18 rejects coverage redirection or exclusion: ${comment}`, async () => {
    await withFiles(
      {
        "package.json": '{"type":"module"}',
        "main.ts": `${comment}\nexport const value = 1;`,
        "main.test.ts":
          'import { test } from "node:test"; import assert from "node:assert/strict"; import { value } from "./main.ts"; await test("value", () => { assert.equal(value, 1); });',
      },
      (directory) => {
        assert.throws(() => {
          checkTests(directory, [join(directory, "main.test.ts")], {
            coverageFiles: [join(directory, "main.ts")],
          });
        }, diagnostic);
      },
    );
  });
}

await test("QG-18 ignores unrelated virtual scripts without treating them as missing production", async () => {
  await withFiles(
    {
      "package.json": '{"type":"module"}',
      "main.ts": "export const value = 1;",
      "main.test.ts":
        'import { test } from "node:test"; import assert from "node:assert/strict"; import { runInNewContext } from "node:vm"; import { value } from "./main.ts"; await test("value", () => { assert.equal(value, 1); assert.equal(runInNewContext("2+2", {}, { filename: "file:///cloving-missing-virtual-source.js" }), 4); });',
    },
    (directory) => {
      assert.doesNotThrow(() => {
        checkTests(directory, [join(directory, "main.test.ts")], {
          coverageFiles: [join(directory, "main.ts")],
        });
      });
    },
  );
});
