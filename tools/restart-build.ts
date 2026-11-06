import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { stepped, type CheckoutCommands } from "./restart-update.ts";

const buildInputs = [
  "src",
  "tools",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
];

function changedAt(file: string): Promise<number> {
  return stat(file).then(
    (status) => status.mtimeMs,
    () => 0,
  );
}

async function newestOutput(folder: string): Promise<number | undefined> {
  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => undefined);
  if (entries === undefined) return undefined;
  const times = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => changedAt(join(entry.parentPath, entry.name))),
  );
  return Math.max(0, ...times);
}

async function newestSource(
  checkout: string,
  git: CheckoutCommands["git"],
): Promise<number> {
  const listed = await git(["ls-files", "-z", "--", ...buildInputs]);
  const names = listed.split("\0").filter((name) => name !== "");
  const times = await Promise.all(
    names.map((name) => changedAt(join(checkout, name))),
  );
  return Math.max(0, ...times);
}

export async function staleBuild(
  checkout: string,
  git: CheckoutCommands["git"],
): Promise<boolean> {
  const built = await newestOutput(join(checkout, "dist"));
  if (built === undefined) return true;
  return (await newestSource(checkout, git)) > built;
}

export async function checkedBuild(
  checkout: string,
  commands: CheckoutCommands,
): Promise<string | undefined> {
  const stale = await stepped("build", () =>
    staleBuild(checkout, commands.git),
  );
  if (stale.kind === "failed") return stale.output;
  if (!stale.value) return undefined;
  const built = await stepped("build", () => commands.npm(["run", "build"]));
  return built.kind === "failed" ? built.output : undefined;
}
