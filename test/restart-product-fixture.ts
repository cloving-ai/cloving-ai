import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const worktree = join(import.meta.dirname, "..");

export type ProductGit = (argumentsList: readonly string[]) => string;

export function productGit(product: string): ProductGit {
  return (argumentsList) =>
    execFileSync("git", ["-C", product, ...argumentsList], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

export async function productCopy(root: string): Promise<string> {
  const product = join(root, "product");
  await mkdir(product);
  for (const name of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.build.json",
  ])
    copyFileSync(join(worktree, name), join(product, name));
  for (const name of ["src", "tools", "templates"])
    cpSync(join(worktree, name), join(product, name), { recursive: true });
  symlinkSync(join(worktree, "node_modules"), join(product, "node_modules"));
  execFileSync(
    process.execPath,
    [
      join(product, "node_modules/typescript/bin/tsc"),
      "--project",
      "tsconfig.build.json",
    ],
    {
      cwd: product,
      timeout: 60_000,
      stdio: "pipe",
      env: { ...process.env, NODE_V8_COVERAGE: undefined },
    },
  );
  const git = productGit(product);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Owner"]);
  git(["config", "user.email", "owner@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  await writeFile(join(product, ".git/info/exclude"), "dist\nnode_modules\n");
  git(["add", "."]);
  git(["commit", "-qm", "Copy the product"]);
  return product;
}
