import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import ts from "typescript";
import { record } from "../src/protocol.ts";
import {
  isCandidateFacts,
  type CandidateFacts,
} from "./workflow-candidate-facts.ts";
import metadata from "#package" with { type: "json" };
import {
  boundedRead,
  workflowBuildKey,
  rememberWorkflowBuild,
} from "./self-host-build-cache.ts";
import {
  workflowBundleDependencies,
  workflowPackageRoot,
} from "./workflow-bundle-dependencies.ts";
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

async function analysisContext(): Promise<string> {
  const analyzer = await workflowPackageRoot(
    resolve(import.meta.dirname, ".."),
  );
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify([2, process.version, process.platform, process.arch]),
  );
  const analyzerMetadata = await readFile(join(analyzer, "package.json"));
  hash.update(JSON.stringify([metadata, analyzerMetadata.length]));
  hash.update(analyzerMetadata);
  hash.update(
    await workflowBuildKey({
      product: analyzer,
      project: analyzer,
      recordedProject: "analyzer-epoch",
      dependencies: "",
    }),
  );
  const library = dirname(ts.sys.getExecutingFilePath());
  const names = (await readdir(library))
    .sort()
    .filter((name) => name.endsWith(".js") || name.endsWith(".d.ts"));
  const contents = await Promise.all(
    names.map((name) => boundedRead(join(library, name))),
  );
  for (const [index, bytes] of contents.entries()) {
    hash.update(JSON.stringify([names[index], bytes.length]));
    hash.update(bytes);
  }
  return hash.digest("hex");
}

const executingContext = await analysisContext().catch(() => undefined);

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
  const build = await workflowBuildKey({
    product: input.packageRoot,
    project: input.project,
    recordedProject: "candidate",
    dependencies,
  });
  const context = await analysisContext();
  if (context !== executingContext) return undefined;
  const key = createHash("sha256")
    .update(JSON.stringify([build, context]))
    .digest("hex");
  return {
    key,
    dependencies,
    project: input.project,
    repository: input.packageRoot,
    directory: join(input.cacheDirectory, "bundles"),
    index: join(input.cacheDirectory, key),
  };
}

async function verifiedFactBytes(
  directory: string,
): Promise<string | undefined> {
  const bytes = await readFile(join(directory, "analysis.json"), "utf8");
  const bundle = await readFile(join(directory, "bundle.json"), "utf8");
  if (createHash("sha256").update(bundle).digest("hex") !== basename(directory))
    return undefined;
  const files = record(record(JSON.parse(bundle))?.["files"]);
  if (
    files?.["analysis.json"] !==
    createHash("sha256").update(bytes).digest("hex")
  )
    return undefined;
  return bytes;
}

export async function restoredCandidateFacts(
  cache: CandidateCache | undefined,
  directory: string | undefined,
): Promise<CandidateFacts | undefined> {
  if (cache === undefined || directory === undefined) return undefined;
  try {
    const bytes = await verifiedFactBytes(directory);
    if (bytes === undefined) return undefined;
    const proof = record(JSON.parse(bytes));
    if (proof?.["schemaVersion"] !== 1 || proof["key"] !== cache.key)
      return undefined;
    if (
      Object.keys(proof).some(
        (name) => !["schemaVersion", "key", "facts"].includes(name),
      )
    )
      return undefined;
    const facts = proof["facts"];
    return isCandidateFacts(facts) ? facts : undefined;
  } catch {
    return undefined;
  }
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
  facts: CandidateFacts,
): Promise<void> {
  if (cache === undefined) return;
  try {
    for (const [name, text] of [
      ["declarations.json", "[]"],
      ["dependencies.json", cache.dependencies],
      ["build-inputs.json", JSON.stringify(cache.key)],
      [
        "analysis.json",
        JSON.stringify({ schemaVersion: 1, key: cache.key, facts }),
      ],
    ])
      await writeFile(join(cache.project, String(name)), String(text));
    const bundleDigest = await retainWorkflowBundle(cache);
    await rememberWorkflowBuild({ project: cache.index, bundleDigest });
  } catch {
    return;
  }
}
