import { createHash, randomUUID } from "node:crypto";
import { cp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readRetainedWorkflowBundle } from "./workflow-bundles.ts";

function absent(error: unknown): undefined {
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    return undefined;
  throw error;
}

async function inputFiles(root: string, name: string): Promise<string[]> {
  const entries = await readdir(join(root, name), {
    withFileTypes: true,
  }).catch(absent);
  const files: string[] = [];
  for (const entry of entries ?? []) {
    const path = join(name, entry.name);
    if (entry.isDirectory()) files.push(...(await inputFiles(root, path)));
    else files.push(path);
  }
  return files.sort();
}

async function inputDigests(root: string, names: readonly string[]) {
  return Promise.all(
    names.map(async (name) => {
      const bytes = await readFile(join(root, name));
      return [name, createHash("sha256").update(bytes).digest("hex")];
    }),
  );
}

export async function workflowBuildKey(input: {
  readonly product: string;
  readonly project: string;
  readonly recordedProject?: string;
  readonly dependencies: string;
}): Promise<string> {
  const productFiles = (
    await Promise.all(
      ["src", "tools"].map((name) => inputFiles(input.product, name)),
    )
  ).flat();
  const workflows = await inputFiles(input.project, "workflows");
  return createHash("sha256")
    .update(
      JSON.stringify({
        product: input.product,
        project: input.recordedProject ?? input.project,
        dependencies: input.dependencies,
        productFiles: await inputDigests(input.product, productFiles),
        workflows: await inputDigests(input.project, workflows),
      }),
    )
    .digest("hex");
}

export async function restoreWorkflowArtifacts(input: {
  readonly project: string;
  readonly repository: string;
  readonly key: string;
}): Promise<boolean> {
  try {
    const id = await readFile(`${input.project}.build`, "utf8");
    const bundle = await readRetainedWorkflowBundle({
      directory: join(dirname(input.project), "workflow-bundles"),
      repository: input.repository,
      id,
    });
    if (bundle.kind !== "available") return false;
    if (
      (await readFile(join(bundle.directory, "build-inputs.json"), "utf8")) !==
      JSON.stringify(input.key)
    )
      return false;
    await cp(
      join(bundle.directory, "artifacts"),
      join(input.project, "artifacts"),
      { recursive: true },
    );
    return true;
  } catch {
    return false;
  }
}

export async function rememberWorkflowBuild(input: {
  readonly project: string;
  readonly bundleDigest: string;
}): Promise<void> {
  const temporary = `${input.project}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, input.bundleDigest, { mode: 0o600 });
    await rename(temporary, `${input.project}.build`);
  } finally {
    await rm(temporary, { force: true });
  }
}
