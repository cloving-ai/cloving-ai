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
import { pathToFileURL } from "node:url";
import { record } from "../src/protocol.ts";
import { candidateProgram as installedProgram } from "../tools/workflow-candidate-program.ts";
import { analyzeWorkflowCandidate as installedAnalysis } from "../tools/workflow-candidate-source.ts";
import { admitWorkflowCandidate as installedAdmission } from "../tools/admit-workflow.ts";
import { loadWorkflowFolders as installedFolders } from "../tools/workflow-folders.ts";
import { testMilliseconds } from "./test-timing.ts";

const product = join(import.meta.dirname, "..");
const childTimeout = testMilliseconds(30_000);
const directory = realpathSync(
  mkdtempSync(join(tmpdir(), "cloving-candidate-package-")),
);
export const candidatePackageRoot = directory;
process.once("exit", () => {
  rmSync(directory, { recursive: true, force: true });
});
for (const name of ["package.json", "tsconfig.json", "tsconfig.build.json"])
  copyFileSync(join(product, name), join(directory, name));
for (const name of ["src", "tools", "workflows", "templates"])
  cpSync(join(product, name), join(directory, name), { recursive: true });
symlinkSync(join(product, "node_modules"), join(directory, "node_modules"));
execFileSync(
  process.execPath,
  [
    join(product, "node_modules/typescript/bin/tsc"),
    "--project",
    "tsconfig.build.json",
  ],
  {
    cwd: directory,
    timeout: childTimeout,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, NODE_V8_COVERAGE: undefined },
  },
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

export function loadWorkflowFolders(
  input: Parameters<typeof installedFolders>[0],
) {
  return installedFolders(input, { packageRoot: directory });
}

export function preparedProject(input: {
  readonly project: string;
  readonly repository: string;
  readonly home: string;
  readonly xdgConfigHome: string;
}) {
  const entry = pathToFileURL(join(directory, "tools/self-host-project.ts"));
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { preparedProject } from ${JSON.stringify(entry.href)};
process.stdout.write(JSON.stringify(await preparedProject(${JSON.stringify({ ...input, product: directory })})));`,
    ],
    { cwd: directory, timeout: childTimeout, encoding: "utf8", stdio: "pipe" },
  );
  const parsed: unknown = JSON.parse(output);
  const result = record(parsed);
  if (!result) throw new Error("invalid-project-result");
  return result;
}
