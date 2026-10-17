import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const [source, output] = process.argv.slice(2);
if (!source || !output)
  throw new Error("Usage: copy-workflow-declarations SOURCE OUTPUT");
await mkdir(output, { recursive: true });
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (entry.name.endsWith(".declaration.json"))
    await copyFile(join(source, entry.name), join(output, entry.name));
}
