import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./command.ts";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) =>
    record(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

export async function checkNpmInputs(directory: string): Promise<void> {
  const manifest: unknown = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
  const lock: unknown = JSON.parse(
    await readFile(join(directory, "package-lock.json"), "utf8"),
  );
  if (
    !record(manifest) ||
    !record(lock) ||
    lock["lockfileVersion"] !== 3 ||
    !record(lock["packages"])
  )
    throw new Error("invalid-npm-dependency-inputs");
  const root = lock["packages"][""];
  if (!record(root)) throw new Error("missing-root-lock-record");
  for (const field of [
    "name",
    "version",
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "workspaces",
    "engines",
    "os",
    "cpu",
  ]) {
    if (canonical(manifest[field]) !== canonical(root[field]))
      throw new Error(`manifest-lock-mismatch: ${field}`);
  }
  await checkInstalledVersions(directory, lock["packages"]);
  await checkInstalledTree(directory);
}

async function checkInstalledVersions(
  directory: string,
  packages: Readonly<Record<string, unknown>>,
): Promise<void> {
  for (const [path, expected] of Object.entries(packages)) {
    if (path === "") continue;
    if (
      !path.startsWith("node_modules/") ||
      path.split(/[\\/]/).some((part) => ["", ".", ".."].includes(part))
    )
      throw new Error(`unsupported-lock-package-path: ${path}`);
    if (!record(expected) || typeof expected["version"] !== "string")
      throw new Error(`unsupported-lock-package-record: ${path}`);
    const file = join(directory, path, "package.json");
    if (!existsSync(file)) continue;
    const installed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!record(installed) || installed["version"] !== expected["version"])
      throw new Error(`installed-lock-mismatch: ${path}`);
  }
}

async function checkInstalledTree(directory: string): Promise<void> {
  const cache = await mkdtemp(join(tmpdir(), "cloving-npm-inventory-"));
  try {
    runCommand({
      executable: "npm",
      arguments: [
        "ls",
        "--all",
        "--json",
        "--ignore-scripts",
        "--offline",
        "--include=dev",
        "--include=optional",
        "--include=peer",
        "--cache",
        cache,
      ],
      directory,
      timeoutMilliseconds: 60000,
    });
  } finally {
    await rm(cache, { recursive: true });
  }
}
