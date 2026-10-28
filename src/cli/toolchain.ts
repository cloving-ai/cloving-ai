import { findPackageJSON } from "node:module";
import { createHash } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import packageMetadata from "#package" with { type: "json" };
import type { ToolchainIdentity } from "../workflow-admission.ts";

export const supportedNodes = packageMetadata.engines.node;

export function supportedNode(version: string): boolean {
  const release = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (release === null) return false;
  const observed = release.slice(1).map(Number);
  return supportedNodes.split(" || ").some((range) => {
    const bounds = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/
      .exec(range)
      ?.slice(1)
      .map(Number);
    if (bounds === undefined) return false;
    return (
      atLeast(observed, bounds.slice(0, 3)) &&
      (observed[0] ?? 0) < (bounds[3] ?? 0)
    );
  });
}

function atLeast(
  observed: readonly number[],
  minimum: readonly number[],
): boolean {
  const index = observed.findIndex(
    (part, position) => part !== minimum[position],
  );
  return index === -1 || (observed[index] ?? 0) > (minimum[index] ?? 0);
}

export async function observedToolchain(
  start: string,
): Promise<ToolchainIdentity> {
  const root = await projectRoot(start);
  const sdk = await packageDirectory(start, "workflow");
  const core =
    sdk === undefined
      ? undefined
      : await packageDirectory(sdk, "@workflow/core");
  const lock = await readFile(join(root, "package-lock.json")).catch(
    () => null,
  );
  return {
    sdk: `workflow@${await installedVersion(start, "workflow")}`,
    world: `@workflow/world-local@${await installedVersion(core ?? start, "@workflow/world-local")}`,
    builder: `@workflow/builders@${await installedVersion(start, "@workflow/builders")}`,
    node: process.version,
    dependencies:
      lock === null
        ? "missing"
        : createHash("sha256").update(lock).digest("hex"),
  };
}

export async function qualifiedToolchain(
  observed: ToolchainIdentity,
  start: string,
): Promise<ToolchainIdentity> {
  const sdk = await packageDirectory(start, "workflow");
  const core = await packageFields(sdk ?? start, "@workflow/core");
  const declared = fields(core["dependencies"])["@workflow/world-local"];
  return {
    sdk: `workflow@${packageMetadata.dependencies.workflow}`,
    world: `@workflow/world-local@${typeof declared === "string" ? declared : "undeclared"}`,
    builder: `@workflow/builders@${packageMetadata.dependencies["@workflow/builders"]}`,
    node: supportedNode(observed.node) ? observed.node : supportedNodes,
    dependencies: observed.dependencies,
  };
}

async function projectRoot(start: string): Promise<string> {
  let directory = start;
  for (;;) {
    const found = await access(join(directory, "package-lock.json")).then(
      () => true,
      () => false,
    );
    const parent = dirname(directory);
    if (found || parent === directory) return directory;
    directory = parent;
  }
}

async function installedVersion(root: string, name: string): Promise<string> {
  const version = (await packageFields(root, name))["version"];
  return typeof version === "string" ? version : "missing";
}

async function packageFields(
  root: string,
  name: string,
): Promise<Readonly<Record<string, unknown>>> {
  const directory = await packageDirectory(root, name);
  if (directory === undefined) return {};
  const text = await readFile(join(directory, "package.json"), "utf8").catch(
    () => "{}",
  );
  return fields(JSON.parse(text));
}

function fields(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

async function packageDirectory(
  start: string,
  name: string,
): Promise<string | undefined> {
  try {
    const file = findPackageJSON(name, join(start, "package.json"));
    return file === undefined ? undefined : dirname(await realpath(file));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_MODULE_NOT_FOUND"
    )
      return undefined;
    throw error;
  }
}
