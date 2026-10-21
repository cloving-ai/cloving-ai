import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cloneArguments } from "./clone-arguments.ts";
import { parseCloneReport, type CloneFinding } from "./clone-report.ts";
import { runCommand, type CommandOptions } from "./command.ts";
import { assertCloneSyntax } from "./clone-syntax.ts";

export async function inspectClones(
  files: readonly string[],
  options?: CommandOptions,
): Promise<CloneFinding[]> {
  if (files.length === 0)
    throw new Error("Cannot scan an empty clone inventory");
  const inputs = await Promise.all(
    files.map((file) => realpath(resolve(file))),
  );
  for (const file of inputs)
    assertCloneSyntax(file, await readFile(file, "utf8"));
  const sizes = await Promise.all(
    inputs.map(async (file) => (await stat(file)).size),
  );
  const maximumBytes = Math.max(...sizes) + 1;
  const directory = await mkdtemp(join(tmpdir(), "cloving-clone-report-"));
  try {
    const config = join(directory, "configuration.json");
    await writeFile(config, "{}");
    runCommand(
      {
        check: "clones",
        executable: process.execPath,
        arguments: [
          ...cloneArguments(inputs, { report: directory, maximumBytes }),
          "--config",
          config,
        ],
        directory,
        timeoutMilliseconds: 30000,
        acceptedExitCodes: [0, 1],
      },
      options,
    );
    const raw: unknown = JSON.parse(
      await readFile(join(directory, "jscpd-report.json"), "utf8"),
    );
    const findings = parseCloneReport(raw);
    const admitted = new Set(inputs);
    for (const finding of findings) {
      if (
        !admitted.has(finding.first.file) ||
        !admitted.has(finding.second.file)
      )
        throw new Error(
          "Clone report references a file outside the supplied inventory",
        );
    }
    return findings;
  } finally {
    await rm(directory, { recursive: true });
  }
}
