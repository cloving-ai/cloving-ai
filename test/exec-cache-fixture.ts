import { readFileSync } from "node:fs";
import { cp, mkdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fields } from "./service-fixture.ts";

export const npxProgram = `npx cloving@${String(
  fields(JSON.parse(readFileSync(resolve("package.json"), "utf8")))["version"],
)}`;

export async function execCacheEntry(root: string): Promise<string> {
  const copy = join(root, "_npx", "0a1b2c3d", "cloving");
  await mkdir(copy, { recursive: true });
  for (const name of ["src", "tools", "templates", "themes", "package.json"])
    await cp(resolve(name), join(copy, name), { recursive: true });
  await symlink(resolve("node_modules"), join(copy, "node_modules"));
  return join(copy, "src/cli.ts");
}
