import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import packageMetadata from "#package" with { type: "json" };
import type { ToolchainIdentity } from "../workflow-admission.ts";

export async function observedToolchain(
  start: string,
): Promise<ToolchainIdentity> {
  const root = await projectRoot(start);
  const lock = await readFile(join(root, "package-lock.json")).catch(
    () => null,
  );
  return {
    sdk: `workflow@${await installedVersion(root, "workflow")}`,
    world: `@workflow/world-local@${await installedVersion(root, "@workflow/world-local")}`,
    builder: `@workflow/builders@${await installedVersion(root, "@workflow/builders")}`,
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
  const core = await packageFields(await projectRoot(start), "@workflow/core");
  const declared = fields(core["dependencies"])["@workflow/world-local"];
  return {
    sdk: `workflow@${packageMetadata.dependencies.workflow}`,
    world: `@workflow/world-local@${typeof declared === "string" ? declared : "undeclared"}`,
    builder: `@workflow/builders@${packageMetadata.devDependencies["@workflow/builders"]}`,
    node: `v${packageMetadata.engines.node}`,
    dependencies: observed.dependencies,
  };
}

async function projectRoot(start: string): Promise<string> {
  let directory = start;
  for (;;) {
    const found = await access(
      join(directory, "node_modules", "workflow", "package.json"),
    ).then(
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
  const text = await readFile(
    join(root, "node_modules", name, "package.json"),
    "utf8",
  ).catch(() => "{}");
  return fields(JSON.parse(text));
}

function fields(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}
