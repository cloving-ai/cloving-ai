import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { withFiles } from "./quality/files-fixture.ts";
import { field } from "./self-host-fixture.ts";

const checkoutOnly = new Set([
  ".claude",
  ".cloving",
  ".codex",
  ".git",
  ".swc",
  "coverage",
  "dist",
  "node_modules",
]);

export function packedCommand(
  executable: string,
  options: {
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): string {
  const result = spawnSync(executable, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

export async function packCheckoutCopy(
  checkout: string,
  destination: string,
): Promise<unknown> {
  return await withFiles({}, async (directory) => {
    const source = join(directory, "package");
    await cp(checkout, source, {
      recursive: true,
      filter: (path) => !checkoutOnly.has(relative(checkout, path)),
    });
    await symlink(join(checkout, "node_modules"), join(source, "node_modules"));
    packedCommand("npm", { args: ["run", "build"], cwd: source });
    await assert.rejects(lstat(join(source, "dist/workflows")), {
      code: "ENOENT",
    });
    const packed: unknown = JSON.parse(
      packedCommand("npm", {
        args: [
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          destination,
        ],
        cwd: source,
      }),
    );
    return packed;
  });
}

interface PackedInstallation {
  readonly archive: string;
  readonly checkout: string;
  readonly env?: NodeJS.ProcessEnv;
}

async function prepareConsumer(
  root: string,
  options: PackedInstallation,
): Promise<void> {
  const manifest: unknown = JSON.parse(
    await readFile(join(options.checkout, "package.json"), "utf8"),
  );
  const lock: unknown = JSON.parse(
    await readFile(join(options.checkout, "package-lock.json"), "utf8"),
  );
  const packages = field(lock, "packages");
  assert.ok(packages && typeof packages === "object");
  const source = field(packages, "");
  assert.ok(source && typeof source === "object");
  const metadata = Object.fromEntries(
    Object.entries(source).filter(([name]) => name !== "devDependencies"),
  );
  const resolved = `file:${basename(options.archive)}`;
  const consumer = {
    name: "packed-consumer",
    private: true,
    type: "module",
    dependencies: { cloving: resolved },
    overrides: field(manifest, "overrides"),
  };
  await writeFile(join(root, "package.json"), JSON.stringify(consumer));
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: consumer.name,
      lockfileVersion: 3,
      requires: true,
      packages: {
        ...packages,
        "": consumer,
        "node_modules/cloving": {
          ...metadata,
          resolved,
          integrity: `sha512-${createHash("sha512")
            .update(await readFile(options.archive))
            .digest("base64")}`,
        },
      },
    }),
  );
}

export async function installPacked(
  root: string,
  options: PackedInstallation,
): Promise<void> {
  await prepareConsumer(root, options);
  packedCommand("npm", {
    args: [
      "ci",
      "--ignore-scripts",
      "--omit=dev",
      "--offline",
      "--no-audit",
      "--no-fund",
    ],
    cwd: root,
    ...(options.env ? { env: options.env } : {}),
  });
  await rm(join(root, "node_modules/.package-lock.json"));
  packedCommand("npm", {
    args: ["ls", "--all", "--omit=dev", "--offline"],
    cwd: root,
    ...(options.env ? { env: options.env } : {}),
  });
}
