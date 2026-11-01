import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CoverageRow } from "./coverage.ts";
import { collectCoverage, readScriptCoverage } from "./coverage-report.ts";

export async function exportShardCoverage(
  directory: string,
  run: {
    readonly rawDirectory: string;
    readonly outputDirectory: string;
    readonly files: readonly string[];
  },
): Promise<void> {
  const expected = new Set(
    await Promise.all(run.files.map((file) => realpath(file))),
  );
  await mkdir(dirname(run.outputDirectory), { recursive: true });
  await mkdir(run.outputDirectory);
  const entries = await readdir(run.rawDirectory);
  if (entries.length === 0) throw new Error("missing-raw-coverage");
  for (const name of entries) {
    const recordings = await readScriptCoverage(join(run.rawDirectory, name));
    const result = recordings
      .filter(
        (recording) =>
          recording.url.startsWith("file:") &&
          expected.has(fileURLToPath(recording.url)),
      )
      .map((recording) => ({
        ...recording,
        url: new URL(
          relative(directory, fileURLToPath(recording.url)),
          "cloving:///",
        ).href,
      }));
    await writeFile(
      join(run.outputDirectory, name),
      JSON.stringify({ result }),
    );
  }
}

export async function joinShardCoverage(
  directory: string,
  run: {
    readonly directories: readonly string[];
    readonly files: readonly string[];
  },
): Promise<CoverageRow[]> {
  if (run.directories.length === 0) throw new Error("missing-shard-coverage");
  const expected = new Map(
    await Promise.all(
      run.files.map(async (file) => {
        const path = await realpath(file);
        return [
          new URL(relative(directory, path), "cloving:///").href,
          pathToFileURL(path).href,
        ] as const;
      }),
    ),
  );
  const temporary = await mkdtemp(join(tmpdir(), "cloving-joined-coverage-"));
  try {
    for (const [index, folder] of run.directories.entries()) {
      const entries = await readdir(folder);
      if (entries.length === 0) throw new Error("missing-raw-coverage");
      for (const name of entries) {
        const recordings = await readScriptCoverage(join(folder, name));
        const result = recordings.map((recording) => {
          const url = expected.get(recording.url);
          if (!url) throw new Error("invalid-shard-coverage-source");
          return { ...recording, url };
        });
        await writeFile(
          join(temporary, `${String(index)}-${name}`),
          JSON.stringify({ result }),
        );
      }
    }
    return await collectCoverage(temporary, run.files);
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}
