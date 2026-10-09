export const requiredChecks = [
  "inventory",
  "compiler",
  "architecture",
  "suppressions",
  "test-integrity",
  "format",
  "lint",
  "structure",
  "clones",
  "tests",
] as const;

export interface ProjectOptions extends SourceOptions {
  readonly trustedCompilerConfiguration?: string;
  readonly architecture: DependencyPolicy;
  readonly stepExports: Readonly<Record<string, readonly string[]>>;
  readonly suppressionApprovals?: readonly SuppressionApproval[];
  readonly requiredTests?: Readonly<Record<string, readonly string[]>>;
}

export function assertCheckCoverage(completed: readonly string[]): void {
  if (JSON.stringify(completed) !== JSON.stringify(requiredChecks))
    throw new Error("Quality report has missing or repeated required checks");
}

export async function checkProject(
  directory: string,
  options: ProjectOptions,
): Promise<{ files: string[]; completed: string[] }> {
  const { program, files, completed } = await checkProjectSources(
    directory,
    options,
  );
  checkProjectTests(program, files, directory, options);
  completed.push("tests");
  assertCheckCoverage(completed);
  return { files, completed };
}

export async function checkProjectSources(
  directory: string,
  options: ProjectOptions,
): Promise<{
  files: string[];
  completed: string[];
  program: ReturnType<typeof compilerProgram>;
}> {
  const completed: string[] = [];
  const files = await sourceFiles(directory, options);
  completed.push("inventory");
  const program = compilerProgram(directory, files, {
    ...(options.trustedCompilerConfiguration
      ? { trustedConfiguration: options.trustedCompilerConfiguration }
      : {}),
  });
  completed.push("compiler");
  checkArchitecture(program, options.architecture);
  const boundaries = inspectWorkflowBoundaries(program, {
    roles: options.architecture.roles,
    stepExports: options.stepExports,
  });
  if (boundaries.length > 0)
    throw new Error(`Workflow boundaries failed:\n${boundaries.join("\n")}`);
  completed.push("architecture");
  const sources = program
    .getSourceFiles()
    .filter((source) => files.includes(source.fileName));
  checkSuppressions(sources, options.suppressionApprovals ?? []);
  completed.push("suppressions");
  const testIntegrity = inspectTestIntegrity(program);
  if (testIntegrity.length > 0)
    throw new Error(`Test integrity failed:\n${testIntegrity.join("\n")}`);
  completed.push("test-integrity");
  await checkFormatting(files);
  completed.push("format");
  await checkLint(
    directory,
    files,
    options.suppressionApprovals ?? [],
    program,
  );
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
  return { program, files, completed };
}

function checkProjectTests(
  program: ReturnType<typeof compilerProgram>,
  files: readonly string[],
  directory: string,
  options: ProjectOptions,
): void {
  const production = productionInventory(
    program,
    files,
    options.architecture.roles,
  );
  checkTests(directory, files, {
    ...(production.length > 0 ? { coverageFiles: production } : {}),
    ...(options.requiredTests ? { requiredTests: options.requiredTests } : {}),
  });
}
import { compilerProgram } from "./compiler.ts";
import { inspectClones } from "./clones.ts";
import { checkFormatting, checkLint } from "./source-checks.ts";
import { sourceFiles } from "./source-files.ts";
import type { SourceOptions } from "./source-files.ts";
import { inspectStructure } from "./structure.ts";
import { checkTests } from "./test-execution.ts";
import { checkSuppressions } from "./suppression-approval.ts";
import { inspectTestIntegrity } from "./test-integrity.ts";
import type { DependencyPolicy } from "./dependency-policy.ts";
import { checkArchitecture } from "./architecture.ts";
import { inspectWorkflowBoundaries } from "./workflow-boundaries.ts";
import { productionInventory } from "./production-inventory.ts";
import type { SuppressionApproval } from "./suppression-approval.ts";
