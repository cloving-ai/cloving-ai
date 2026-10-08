import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export async function withFiles<Result>(
  files: Readonly<Record<string, string>>,
  inspect: (directory: string) => Promise<Result> | Result,
): Promise<Result> {
  const directory = await mkdtemp(join(tmpdir(), "cloving-project-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(directory, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    return await inspect(directory);
  } finally {
    await rm(directory, { recursive: true });
  }
}
