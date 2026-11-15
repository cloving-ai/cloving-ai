import { restartTrace } from "./restart-trace.ts";
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
import nodeModule from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkWorkflowCandidate,
  isCandidateDeclaration,
  candidateDeclarationRefusals,
  workflowHelperPath,
  type WorkflowCandidateCode,
} from "../src/workflow-candidate.ts";
import {
  candidatePackageRoot,
  type CandidatePackageOptions,
} from "./workflow-candidate-program.ts";
import { analyzeWorkflowCandidate } from "./workflow-candidate-source.ts";
import type { WorkflowLimits } from "../src/workflow-limits.ts";
import { isWorkflowManifest } from "./workflow-manifest.ts";
import { queueFeed } from "../src/workflow-declaration.ts";
import {
  candidateCache,
  restoredCandidate,
  rememberedCandidate,
  restoredCandidateFacts,
} from "./workflow-candidate-cache.ts";
import type { CandidateFacts } from "./workflow-candidate-facts.ts";

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
    readonly limits?: WorkflowLimits;
  },
  installed: CandidatePackageOptions = {},
): Promise<WorkflowCandidateAdmission> {
  const { source, declaration } = input;
  const refusal = candidateDeclarationRefusals(declaration, input.limits);
  if (refusal.length > 0) return { kind: "refused", codes: refusal };
  if (Buffer.from(source, "utf8").toString("utf8") !== source)
    return { kind: "refused", codes: ["unsupported-source"] };
  try {
    const packageRoot = resolve(installed.packageRoot ?? candidatePackageRoot);
    const helpers = input.helpers ?? {};
    return await compiledCandidate({
      source,
      declaration,
      limits: input.limits,
      helpers,
      packageRoot,
      cacheDirectory: installed.cacheDirectory,
      workflowCount: declaredWorkflowCount(declaration),
    });
  } catch {
    return { kind: "refused", codes: ["compile-failed"] };
  }
}

function declaredWorkflowCount(declaration: unknown): number {
  if (!isCandidateDeclaration(declaration)) return 1;
  return queueFeed(declaration.workflow) === undefined ? 1 : 2;
}

function analyzedCandidate(
  input: {
    readonly source: string;
    readonly packageRoot: string;
    readonly helpers: Readonly<Record<string, string>>;
  },
  reused: CandidateFacts | undefined,
): CandidateFacts {
  if (reused !== undefined) {
    restartTrace("analysis-cache-hit");
    return reused;
  }
  restartTrace("analysis-start");
  const facts = analyzeWorkflowCandidate(input.source, {
    packageRoot: input.packageRoot,
    helpers: input.helpers,
  });
  restartTrace("analysis-end");
  return facts;
}

async function compiledCandidate(input: {
  readonly source: string;
  readonly declaration: unknown;
  readonly limits: WorkflowLimits | undefined;
  readonly helpers: Readonly<Record<string, string>>;
  readonly packageRoot: string;
  readonly workflowCount: number;
  readonly cacheDirectory: string | undefined;
}): Promise<WorkflowCandidateAdmission> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "cloving-candidate-")),
  );
  try {
    await prepareCandidateProject(directory, input);
    const cache = await candidateCache({ ...input, project: directory });
    const restored = await restoredCandidate(cache);
    const reused = await restoredCandidateFacts(cache, restored);
    const facts = analyzedCandidate(input, reused);
    const codes = checkWorkflowCandidate({
      declaration: input.declaration,
      ...facts,
      ...(input.limits === undefined ? {} : { limits: input.limits }),
    });
    if (codes.length > 0) return { kind: "refused", codes };
    restartTrace(
      restored === undefined ? "candidate-cache-miss" : "candidate-cache-hit",
    );
    if (restored === undefined && !(await compile(directory)))
      return { kind: "refused", codes: ["compile-failed"] };
    const artifactDirectory = join(restored ?? directory, "artifacts");
    const artifactDigest = await compiledDigest(artifactDirectory, input);
    if (artifactDigest === undefined)
      return { kind: "refused", codes: ["compile-failed"] };
    if (restored === undefined) await rememberedCandidate(cache, facts);
    return { kind: "admitted", artifactDigest };
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
  const runtime = nodeModule.findPackageJSON("workflow", import.meta.url);
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
    restartTrace("candidate-compiler-start");
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
      restartTrace("candidate-compiler-end");
      settle(code === 0);
    });
  });
}

async function compiledDigest(
  artifactDirectory: string,
  input: {
    readonly helpers: Readonly<Record<string, string>>;
    readonly workflowCount: number;
  },
): Promise<string | undefined> {
  const manifest: unknown = JSON.parse(
    await readFile(join(artifactDirectory, "manifest.json"), "utf8"),
  );
  if (
    !isWorkflowManifest(manifest) ||
    Object.values(manifest.workflows ?? {}).flatMap((entries) =>
      Object.values(entries),
    ).length !== input.workflowCount
  )
    return undefined;
  const digest = createHash("sha256");
  for (const [name, content] of Object.entries(input.helpers).sort(
    ([left], [right]) => (left < right ? -1 : Number(left > right)),
  ))
    digest.update(JSON.stringify([name, content]));
  for (const name of ["manifest.json", "flow.mjs", "steps.mjs", "client.mjs"]) {
    const bytes = await readFile(join(artifactDirectory, name));
    digest.update(JSON.stringify([name, bytes.length]));
    digest.update(bytes);
  }
  return digest.digest("hex");
}
