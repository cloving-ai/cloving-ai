import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { findPackageJSON } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkWorkflowCandidate,
  workflowHelperPath,
  type WorkflowCandidateCode,
} from "../src/workflow-candidate.ts";
import {
  candidatePackageRoot,
  type CandidatePackageOptions,
} from "./workflow-candidate-program.ts";
import { analyzeWorkflowCandidate } from "./workflow-candidate-source.ts";
import { isWorkflowManifest } from "./workflow-manifest.ts";

export type WorkflowCandidateAdmission =
  | { readonly kind: "admitted"; readonly artifactDigest: string }
  | {
      readonly kind: "refused";
      readonly codes: readonly (WorkflowCandidateCode | "compile-failed")[];
    };

export async function admitWorkflowCandidate(
  input: {
    readonly source: string;
    readonly declaration: unknown;
    readonly helpers?: Readonly<Record<string, string>>;
  },
  installed: CandidatePackageOptions = {},
): Promise<WorkflowCandidateAdmission> {
  const { source, declaration } = input;
  if (Buffer.from(source, "utf8").toString("utf8") !== source)
    return { kind: "refused", codes: ["unsupported-source"] };
  try {
    const packageRoot = resolve(installed.packageRoot ?? candidatePackageRoot);
    const helpers = input.helpers ?? {};
    const facts = analyzeWorkflowCandidate(source, { packageRoot, helpers });
    const codes = checkWorkflowCandidate({ declaration, ...facts });
    if (codes.length > 0) return { kind: "refused", codes };
    return await compiledCandidate({ source, helpers, packageRoot });
  } catch {
    return { kind: "refused", codes: ["compile-failed"] };
  }
}

async function compiledCandidate(input: {
  readonly source: string;
  readonly helpers: Readonly<Record<string, string>>;
  readonly packageRoot: string;
}): Promise<WorkflowCandidateAdmission> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "cloving-candidate-")),
  );
  try {
    await prepareCandidateProject(directory, input);
    if (!(await compile(directory)))
      return { kind: "refused", codes: ["compile-failed"] };
    const artifactDirectory = join(directory, "artifacts");
    const manifest: unknown = JSON.parse(
      await readFile(join(artifactDirectory, "manifest.json"), "utf8"),
    );
    if (
      !isWorkflowManifest(manifest) ||
      Object.values(manifest.workflows ?? {}).flatMap((entries) =>
        Object.values(entries),
      ).length !== 1
    )
      return { kind: "refused", codes: ["compile-failed"] };
    const digest = createHash("sha256");
    for (const [name, content] of Object.entries(input.helpers).sort(
      ([left], [right]) => (left < right ? -1 : Number(left > right)),
    ))
      digest.update(JSON.stringify([name, content]));
    for (const name of [
      "manifest.json",
      "flow.mjs",
      "steps.mjs",
      "client.mjs",
    ]) {
      const bytes = await readFile(join(artifactDirectory, name));
      digest.update(JSON.stringify([name, bytes.length]));
      digest.update(bytes);
    }
    return { kind: "admitted", artifactDigest: digest.digest("hex") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function prepareCandidateProject(
  directory: string,
  input: {
    readonly source: string;
    readonly helpers: Readonly<Record<string, string>>;
    readonly packageRoot: string;
  },
): Promise<void> {
  const { source, packageRoot } = input;
  await mkdir(join(directory, "workflows"));
  await mkdir(join(directory, "node_modules"));
  await symlink(packageRoot, join(directory, "node_modules/cloving"));
  const runtime = findPackageJSON("workflow", import.meta.url);
  if (!runtime) throw new Error("candidate-runtime-unavailable");
  await symlink(dirname(runtime), join(directory, "node_modules/workflow"));
  await writeFile(
    join(directory, "package.json"),
    '{"name":"candidate-project","private":true,"type":"module"}',
  );
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "ESNext",
        moduleResolution: "Bundler",
        types: [],
      },
      include: ["workflows/candidate.ts"],
    }),
  );
  await writeFile(join(directory, "workflows/candidate.ts"), source, "utf8");
  for (const [name, content] of Object.entries(input.helpers)) {
    if (workflowHelperPath("candidate.ts", `./${name}`) !== name)
      throw new Error("invalid-workflow-helper");
    const path = join(directory, "workflows", name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

function compile(directory: string): Promise<boolean> {
  const extension = extname(fileURLToPath(import.meta.url));
  const executable = fileURLToPath(
    new URL(`./compile-workflows${extension}`, import.meta.url),
  );
  return new Promise((settle) => {
    const child = spawn(
      process.execPath,
      [executable, "workflows", "artifacts"],
      {
        cwd: directory,
        env: { PATH: dirname(process.execPath), TMPDIR: tmpdir() },
        stdio: "ignore",
        timeout: 30000,
      },
    );
    child.once("error", () => {
      settle(false);
    });
    child.once("close", (code) => {
      settle(code === 0);
    });
  });
}
