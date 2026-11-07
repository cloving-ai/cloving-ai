import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stepped, type CheckoutCommands } from "./restart-update.ts";

const buildInputs = [
  "src",
  "tools",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
];

const passedBuild = join("dist", ".restart-build");

function changedAt(file: string): Promise<number> {
  return stat(file).then(
    (status) => status.mtimeMs,
    () => 0,
  );
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
  const passed = await changedAt(join(checkout, passedBuild));
  if (passed === 0) return true;
  return (await newestSource(checkout, git)) > passed;
}

export async function rememberedBuild(checkout: string): Promise<void> {
  const record = join(checkout, passedBuild);
  await mkdir(dirname(record), { recursive: true });
  await writeFile(record, "");
}

async function recordedBuild(
  checkout: string,
  commands: CheckoutCommands,
): Promise<string> {
  const output = await commands.npm(["run", "build"]);
  await rememberedBuild(checkout);
  return output;
}

export function forgottenBuild(checkout: string): Promise<void> {
  return rm(join(checkout, passedBuild), { force: true });
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
  const built = await stepped("build", () => recordedBuild(checkout, commands));
  return built.kind === "failed" ? built.output : undefined;
}
