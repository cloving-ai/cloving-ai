export const requiredChecks = [
  "inventory",
  "compiler",
  "format",
  "lint",
  "structure",
  "clones",
  "tests",
] as const;

export function assertCheckCoverage(completed: readonly string[]): void {
  if (JSON.stringify(completed) !== JSON.stringify(requiredChecks))
    throw new Error("Quality report has missing or repeated required checks");
}

export async function checkProject(
  directory: string,
): Promise<{ files: string[]; completed: string[] }> {
  const completed: string[] = [];
  const files = await sourceFiles(directory);
  completed.push("inventory");
  const program = compilerProgram(directory, files);
  completed.push("compiler");
  await checkFormatting(files);
  completed.push("format");
  await checkLint(directory, files);
  completed.push("lint");
  const structural = inspectStructure(program);
  if (structural.length > 0)
    throw new Error(
      `Structure failed:\n${JSON.stringify(structural, null, 2)}`,
    );
  completed.push("structure");
  const clones = await inspectClones(files);
  if (clones.length > 0)
    throw new Error(
      `Clone threshold exceeded:\n${JSON.stringify(clones, null, 2)}`,
    );
  completed.push("clones");
  checkTests(directory, files);
  completed.push("tests");
  assertCheckCoverage(completed);
  return { files, completed };
}
import { compilerProgram } from "./compiler.ts";
import { inspectClones } from "./clones.ts";
import { checkFormatting, checkLint } from "./source-checks.ts";
import { sourceFiles } from "./source-files.ts";
import { inspectStructure } from "./structure.ts";
import { checkTests } from "./test-execution.ts";
