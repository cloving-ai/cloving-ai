import type { WorkflowArtifactContract } from "./workflow-artifacts.ts";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { productStepIdentities } from "./product-steps.ts";
import { snapshotTree } from "./tree-snapshot.ts";
import { inspectWorkflowArtifacts } from "./workflow-artifacts.ts";

export interface AcceptanceArtifact {
  readonly name: string;
  readonly path: string;
  readonly digest: string;
  readonly regenerated?: string;
  readonly contract?: WorkflowArtifactContract;
}

const binders: Readonly<
  Record<
    string,
    (artifact: AcceptanceArtifact, candidate: string) => Promise<void>
  >
> = {
  "typescript-output": bindOutput,
  "package-tarball": bindPackage,
  "workflow-handlers": bindHandlers,
};

export async function checkArtifacts(
  artifacts: readonly AcceptanceArtifact[],
  required: readonly string[],
  candidate: string,
): Promise<void> {
  for (const name of required) {
    const artifact = artifacts.find((item) => item.name === name);
    if (!artifact) throw new Error(`missing-acceptance-artifact: ${name}`);
    if ((await artifactDigest(artifact.path)) !== artifact.digest)
      throw new Error(`stale-acceptance-artifact: ${name}`);
    try {
      const bind = binders[name];
      if (!bind) throw new Error("unsupported-acceptance-artifact");
      await bind(artifact, candidate);
    } catch (error) {
      throw new Error(`unbound-acceptance-artifact: ${name}`, { cause: error });
    }
  }
}

async function artifactDigest(path: string): Promise<string> {
  const status = await lstat(path);
  if (status.isDirectory()) return (await snapshotTree(path)).identity;
  if (!status.isFile()) throw new Error(`invalid-acceptance-artifact: ${path}`);
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function bindOutput(
  artifact: AcceptanceArtifact,
  candidate: string,
): Promise<void> {
  if (artifact.path !== join(candidate, "dist"))
    return Promise.reject(new Error("foreign-typescript-output"));
  return Promise.resolve();
}

async function bindPackage(
  artifact: AcceptanceArtifact,
  candidate: string,
): Promise<void> {
  const entries = packedEntries(gunzipSync(await readFile(artifact.path)));
  if (entries.length === 0) throw new Error("empty-package-artifact");
  for (const [name, content] of entries) {
    const parts = name.split("/");
    if (parts[0] !== "package" || parts.includes(".."))
      throw new Error(`foreign-package-entry: ${name}`);
    const local = await readFile(join(candidate, ...parts.slice(1)));
    if (!local.equals(content))
      throw new Error(`foreign-package-entry: ${name}`);
  }
}

async function bindHandlers(
  artifact: AcceptanceArtifact,
  candidate: string,
): Promise<void> {
  if (!artifact.regenerated || !artifact.contract)
    throw new Error("missing-workflow-regeneration");
  const required = await productStepIdentities(candidate);
  const missing = required.find(
    (identity) => !artifact.contract?.steps.includes(identity),
  );
  if (missing !== undefined)
    throw new Error(`unbound-product-step: ${missing}`);
  await inspectWorkflowArtifacts(
    artifact.path,
    artifact.regenerated,
    artifact.contract,
  );
}

function packedEntries(archive: Buffer): Array<[string, Buffer]> {
  const entries: Array<[string, Buffer]> = [];
  let offset = 0;
  while (offset + 512 <= archive.length && archive[offset] !== 0) {
    const header = archive.subarray(offset, offset + 512);
    const size = Number.parseInt(field(header, 124, 12) || "0", 8);
    if (!Number.isSafeInteger(size)) throw new Error("invalid-package-entry");
    const start = offset + 512;
    if (["0", ""].includes(field(header, 156, 1))) {
      const prefix = field(header, 345, 155);
      const name = field(header, 0, 100);
      entries.push([
        prefix ? `${prefix}/${name}` : name,
        archive.subarray(start, start + size),
      ]);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function field(header: Buffer, start: number, length: number): string {
  const value = header.subarray(start, start + length).toString("utf8");
  const end = value.indexOf("\0");
  return (end === -1 ? value : value.slice(0, end)).trim();
}
