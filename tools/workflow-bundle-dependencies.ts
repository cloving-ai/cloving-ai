import { createHash } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, join, resolve } from "node:path";
import { record } from "../src/protocol.ts";

interface PackageReference {
  readonly name: string;
  readonly optional: boolean;
}

interface CapturedPackage {
  readonly manifest: string;
  readonly dependencies: Record<string, number | null>;
}

interface Capture {
  readonly seen: Map<string, number>;
  readonly packages: CapturedPackage[];
}

export async function workflowPackageRoot(directory: string): Promise<string> {
  const root = resolve(directory);
  try {
    await access(join(root, "package.json"));
    return root;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const parent = dirname(root);
  if (parent === root) throw new Error("workflow-package-unavailable");
  return workflowPackageRoot(parent);
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
    const file = findPackageJSON(reference.name, from);
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

async function capturePackage(
  capture: Capture,
  input: PackageReference & { readonly from: string },
): Promise<number | null> {
  const file = await manifestFile(input.from, input);
  if (file === undefined) return null;
  const previous = capture.seen.get(file);
  if (previous !== undefined) return previous;
  const manifest = await readFile(file, "utf8");
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
  const capture: Capture = { seen: new Map(), packages: [] };
  const roots: Record<string, number | null> = {};
  const manifest = join(
    await workflowPackageRoot(input.product),
    "package.json",
  );
  for (const name of [...input.packages].sort())
    roots[name] = await capturePackage(capture, {
      name,
      from: manifest,
      optional: false,
    });
  return JSON.stringify({
    node: process.version,
    product: createHash("sha256")
      .update(await readFile(manifest))
      .digest("hex"),
    roots,
    packages: capture.packages,
  });
}
