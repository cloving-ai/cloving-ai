import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { observedToolchain, qualifiedToolchain } from "../src/cli/toolchain.ts";

const root = join(import.meta.dirname, "..");

async function field(file: string, path: readonly string[]): Promise<unknown> {
  const document: unknown = JSON.parse(
    await readFile(join(root, file), "utf8"),
  );
  return path.reduce<unknown>(
    (value, name) => Reflect.get(Object(value), name),
    document,
  );
}

await test("CLV-055 the qualified toolchain reads the SDK version from the runtime dependencies", async () => {
  const declared = await field("package.json", ["dependencies", "workflow"]);
  assert.match(String(declared), /^\d+\.\d+\.\d+$/);
  assert.equal(
    await field("package.json", ["devDependencies", "workflow"]),
    undefined,
  );
  const entry = ["packages", "node_modules/workflow"];
  assert.equal(
    await field("package-lock.json", [...entry, "version"]),
    declared,
  );
  assert.equal(await field("package-lock.json", [...entry, "dev"]), undefined);
  const qualified = await qualifiedToolchain(
    await observedToolchain(root),
    root,
  );
  assert.equal(qualified.sdk, `workflow@${String(declared)}`);
  assert.equal(
    qualified.builder,
    `@workflow/builders@${String(await field("package.json", ["devDependencies", "@workflow/builders"]))}`,
  );
});
