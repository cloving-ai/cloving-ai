import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
export {
  commit,
  input,
  completed,
  effects,
  partialEffects,
} from "../templates/develop/develop/scenarios.ts";

export const workflow = fileURLToPath(
  new URL("../templates/develop/develop.ts", import.meta.url),
);

export async function developFiles(
  directory: string,
): Promise<Record<string, string>> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[`repo/.cloving/workflows/${path.slice(directory.length + 1)}`] =
      await readFile(path, "utf8");
  }
  return files;
}
