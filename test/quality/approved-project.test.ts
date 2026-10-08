import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { format } from "prettier";
import { checkProject } from "../../quality/project.ts";
import type { ProjectOptions } from "../../quality/project.ts";
import { withFiles } from "./files-fixture.ts";

const negative =
  "// @ts-expect-error: required negative type test\nexport const invalid: string = 1;\n";

function options(directory: string): ProjectOptions {
  const file = join(directory, "negative.ts");
  return {
    architecture: {
      roles: {
        [file]: "test",
        [join(directory, "main.ts")]: "pure",
        [join(directory, "main.test.ts")]: "test",
        "node:test": "stdlib",
        "node:assert/strict": "stdlib",
      },
      allowed: { pure: ["pure"], test: ["test", "pure", "stdlib"] },
      forbiddenReachability: {},
    },
    stepExports: {},
    requiredTests: { [join(directory, "main.test.ts")]: ["value"] },
    suppressionApprovals: [
      {
        rule: "negative-type-test",
        file,
        line: 1,
        sourceDigest: createHash("sha256").update(negative).digest("hex"),
        justification: "Prove string contract rejects numbers",
        decision: "fixture-independent-review",
        removalCondition: "Remove with the string contract",
      },
    ],
  };
}

async function files(): Promise<Record<string, string>> {
  return {
    "package.json": '{"type":"module"}',
    "tsconfig.json": JSON.stringify({
      extends: resolve("tsconfig.json"),
      compilerOptions: {
        rootDir: ".",
        typeRoots: [resolve("node_modules/@types")],
      },
      include: ["**/*"],
      exclude: [],
    }),
    "negative.ts": negative,
    "main.ts": "export const value = 1;\n",
    "main.test.ts": await format(
      'import { test } from "node:test"; import assert from "node:assert/strict"; import { value } from "./main.ts"; await test("value", () => { assert.equal(value, 1); });',
      { parser: "typescript" },
    ),
  };
}

await test("QG-08 integrated compiler and lint accept one exact reviewed negative type test", async () => {
  await withFiles(await files(), async (directory) => {
    await assert.doesNotReject(checkProject(directory, options(directory)));
  });
});

await test("QG-18 integrated suite enforces the external required-test inventory", async () => {
  const fixture = await files();
  fixture["negative.ts"] = "export {};\n";
  await withFiles(fixture, async (directory) => {
    await assert.rejects(
      checkProject(directory, {
        ...options(directory),
        suppressionApprovals: [],
        requiredTests: {
          [join(directory, "main.test.ts")]: ["value", "missing"],
        },
      }),
      /mandatory-test-inventory-mismatch/,
    );
  });
});
