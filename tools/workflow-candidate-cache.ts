import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import metadata from "#package" with { type: "json" };
import {
  workflowBuildKey,
  rememberWorkflowBuild,
} from "./self-host-build-cache.ts";
import { workflowBundleDependencies } from "./workflow-bundle-dependencies.ts";
import {
  readRetainedWorkflowBundle,
  retainWorkflowBundle,
} from "./workflow-bundles.ts";

interface CandidateCache {
  readonly key: string;
  readonly index: string;
  readonly directory: string;
  readonly repository: string;
  readonly project: string;
  readonly dependencies: string;
}

export async function candidateCache(input: {
  readonly packageRoot: string;
  readonly project: string;
  readonly cacheDirectory: string | undefined;
}): Promise<CandidateCache | undefined> {
  if (input.cacheDirectory === undefined) return undefined;
  const dependencies = await workflowBundleDependencies({
    product: input.packageRoot,
    packages: Object.keys(metadata.dependencies),
  });
  const key = await workflowBuildKey({
    product: input.packageRoot,
    project: input.project,
    recordedProject: "candidate",
    dependencies,
  });
  return {
    key,
    dependencies,
    project: input.project,
    repository: input.packageRoot,
    directory: join(input.cacheDirectory, "bundles"),
    index: join(input.cacheDirectory, key),
  };
}

export async function restoredCandidate(
  cache: CandidateCache | undefined,
): Promise<string | undefined> {
  if (cache === undefined) return undefined;
  try {
    const id = await readFile(`${cache.index}.build`, "utf8");
    const bundle = await readRetainedWorkflowBundle({ ...cache, id });
    if (bundle.kind !== "available") return undefined;
    const key = await readFile(
      join(bundle.directory, "build-inputs.json"),
      "utf8",
    );
    return key === JSON.stringify(cache.key) ? bundle.directory : undefined;
  } catch {
    return undefined;
  }
}

export async function rememberedCandidate(
  cache: CandidateCache | undefined,
): Promise<void> {
  if (cache === undefined) return;
  try {
    for (const [name, text] of [
      ["declarations.json", "[]"],
      ["dependencies.json", cache.dependencies],
      ["build-inputs.json", JSON.stringify(cache.key)],
    ])
      await writeFile(join(cache.project, String(name)), String(text));
    const bundleDigest = await retainWorkflowBundle(cache);
    await rememberWorkflowBuild({ project: cache.index, bundleDigest });
  } catch {
    return;
  }
}
