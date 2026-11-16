import { createHash } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import nodeModule from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { record } from "../src/protocol.ts";
import { boundedRead } from "./self-host-build-cache.ts";

interface PackageReference {
  readonly name: string;
  readonly optional: boolean;
}

interface CapturedPackage {
  readonly manifest: string;
  readonly dependencies: Record<string, number | null>;
}

type Lookup = PackageReference & { readonly from: string };

interface Reads {
  readonly files: Map<string, Promise<string | undefined>>;
  readonly manifests: Map<string, Promise<string>>;
}

interface Capture {
  readonly reads: Reads;
  readonly seen: Map<string, number>;
  readonly packages: CapturedPackage[];
}

export async function workflowPackageRoot(directory: string): Promise<string> {
  const root = resolve(directory);
  try {
    await access(join(root, "package.json"));
    return await originalPackageRoot(root);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const parent = dirname(root);
  if (parent === root) throw new Error("workflow-package-unavailable");
  return workflowPackageRoot(parent);
}

async function originalPackageRoot(directory: string): Promise<string> {
  if (basename(directory) !== "dist") return directory;
  const parent = dirname(directory);
  const emitted: unknown = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
  try {
    const original: unknown = JSON.parse(
      await readFile(join(parent, "package.json"), "utf8"),
    );
    return record(original) !== undefined &&
      JSON.stringify(emitted) === JSON.stringify(original)
      ? parent
      : directory;
  } catch {
    return directory;
  }
}

function references(
  manifest: Readonly<Record<string, unknown>>,
): PackageReference[] {
  const dependencies = record(manifest["dependencies"]) ?? {};
  const optional = record(manifest["optionalDependencies"]) ?? {};
  const peers = record(manifest["peerDependencies"]) ?? {};
  const peerMetadata = record(manifest["peerDependenciesMeta"]) ?? {};
  return Object.keys({ ...dependencies, ...optional, ...peers })
    .sort()
    .map((name) => ({
      name,
      optional:
        Object.hasOwn(optional, name) ||
        (!Object.hasOwn(dependencies, name) &&
          record(peerMetadata[name])?.["optional"] === true),
    }));
}

async function manifestFile(
  from: string,
  reference: PackageReference,
): Promise<string | undefined> {
  try {
    const file = nodeModule.findPackageJSON(reference.name, from);
    if (file !== undefined) return await realpath(file);
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_MODULE_NOT_FOUND"
    ))
      throw error;
  }
  if (reference.optional) return undefined;
  throw new Error("workflow-dependency-unavailable");
}

function locatedManifest(
  reads: Reads,
  input: Lookup,
): Promise<string | undefined> {
  const key = JSON.stringify([input.from, input.name, input.optional]);
  const known = reads.files.get(key);
  if (known !== undefined) return known;
  const file = manifestFile(input.from, input);
  reads.files.set(key, file);
  return file;
}

function manifestText(reads: Reads, file: string): Promise<string> {
  const known = reads.manifests.get(file);
  if (known !== undefined) return known;
  const text = boundedRead(file).then((bytes) => bytes.toString("utf8"));
  reads.manifests.set(file, text);
  return text;
}

async function prefetch(reads: Reads, input: Lookup): Promise<void> {
  const file = await locatedManifest(reads, input);
  if (file === undefined || reads.manifests.has(file)) return;
  const fields = record(JSON.parse(await manifestText(reads, file)));
  await Promise.allSettled(
    references(fields ?? {}).map((reference) =>
      prefetch(reads, { ...reference, from: file }),
    ),
  );
}

async function capturePackage(
  capture: Capture,
  input: Lookup,
): Promise<number | null> {
  const file = await locatedManifest(capture.reads, input);
  if (file === undefined) return null;
  const previous = capture.seen.get(file);
  if (previous !== undefined) return previous;
  const manifest = await manifestText(capture.reads, file);
  const parsed: unknown = JSON.parse(manifest);
  const fields = record(parsed);
  if (
    typeof fields?.["name"] !== "string" ||
    typeof fields["version"] !== "string"
  )
    throw new Error("invalid-workflow-dependency");
  const captured: CapturedPackage = { manifest, dependencies: {} };
  const index = capture.packages.length;
  capture.seen.set(file, index);
  capture.packages.push(captured);
  for (const reference of references(fields))
    captured.dependencies[reference.name] = await capturePackage(capture, {
      ...reference,
      from: file,
    });
  return index;
}

export async function workflowBundleDependencies(input: {
  readonly product: string;
  readonly packages: readonly string[];
}): Promise<string> {
  const capture: Capture = {
    reads: { files: new Map(), manifests: new Map() },
    seen: new Map(),
    packages: [],
  };
  const manifest = join(
    await workflowPackageRoot(input.product),
    "package.json",
  );
  const lookups = [...input.packages]
    .sort()
    .map((name) => ({ name, from: manifest, optional: false }));
  await Promise.allSettled(
    lookups.map((lookup) => prefetch(capture.reads, lookup)),
  );
  const roots: Record<string, number | null> = {};
  for (const lookup of lookups)
    roots[lookup.name] = await capturePackage(capture, lookup);
  return JSON.stringify({
    node: process.version,
    product: createHash("sha256")
      .update(await readFile(manifest))
      .digest("hex"),
    roots,
    packages: capture.packages,
  });
}
