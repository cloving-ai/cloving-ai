import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateProgram as installedProgram } from "../tools/workflow-candidate-program.ts";
import { analyzeWorkflowCandidate as installedAnalysis } from "../tools/workflow-candidate-source.ts";
import { admitWorkflowCandidate as installedAdmission } from "../tools/admit-workflow.ts";

const product = join(import.meta.dirname, "..");
const directory = realpathSync(
  mkdtempSync(join(tmpdir(), "cloving-candidate-package-")),
);
process.once("exit", () => {
  rmSync(directory, { recursive: true, force: true });
});
for (const name of ["package.json", "tsconfig.json", "tsconfig.build.json"])
  copyFileSync(join(product, name), join(directory, name));
for (const name of ["src", "tools", "workflows"])
  cpSync(join(product, name), join(directory, name), { recursive: true });
symlinkSync(join(product, "node_modules"), join(directory, "node_modules"));
execFileSync(
  process.execPath,
  [
    join(product, "node_modules/typescript/bin/tsc"),
    "--project",
    "tsconfig.build.json",
  ],
  { cwd: directory, timeout: 30_000, encoding: "utf8", stdio: "pipe" },
);

export function candidateProgram(source: string) {
  return installedProgram(source, { packageRoot: directory });
}

export function analyzeWorkflowCandidate(source: string) {
  return installedAnalysis(source, { packageRoot: directory });
}

export function admitWorkflowCandidate(
  input: Parameters<typeof installedAdmission>[0],
) {
  return installedAdmission(input, { packageRoot: directory });
}
