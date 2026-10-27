import { findPackageJSON } from "node:module";
import { createHash } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import packageMetadata from "#package" with { type: "json" };
import type { ToolchainIdentity } from "../workflow-admission.ts";

export const qualifiedNode = "v26.9.0";

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
    node: qualifiedNode,
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
