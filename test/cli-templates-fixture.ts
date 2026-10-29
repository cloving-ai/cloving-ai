import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { cli, cliOptions, entry } from "./cli-workflows-fixture.ts";
import { record } from "../src/protocol.ts";

export const developTemplate: unknown = JSON.parse(
  await readFile("templates/develop/template.json", "utf8"),
);

export const packagedEntry = join(candidatePackageRoot, "src/cli.ts");

export function templates(root: string, args: readonly string[]) {
  return spawnSync(
    process.execPath,
    [entry, "templates", ...args],
    cliOptions(root),
  );
}

export async function filesBelow(folder: string): Promise<readonly string[]> {
  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((item) => item.isFile())
    .map((item) => join(item.parentPath, item.name).slice(folder.length + 1))
    .sort();
}

export function listed(root: string) {
  const result = cli(root, { args: ["list", "--json"], entry: packagedEntry });
  assert.equal(result.status, 0, result.stderr);
  const workflows: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(workflows));
  return workflows.map((item: unknown) => record(item) ?? {});
}

export const repository = { "repo/.gitkeep": "" };

export async function templateFiles(): Promise<readonly string[]> {
  return (await filesBelow("templates/develop")).filter(
    (file) => !["template.json", "README.md"].includes(file),
  );
}
