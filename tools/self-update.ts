export interface SelfUpdateSettings {
  readonly directory: string;
  readonly git: (argumentsList: readonly string[]) => Promise<string>;
  readonly active: () => Promise<boolean>;
  readonly stop: () => Promise<void>;
  readonly error: (line: string) => void;
}

interface UpdateCandidate {
  readonly branch: string;
  readonly head: string;
  readonly target: string;
}

export function lockRequiresInstall(before: string, after: string): boolean {
  try {
    return !isDeepStrictEqual(lockPackages(before), lockPackages(after));
  } catch {
    return true;
  }
}

function lockPackages(text: string): Record<string, unknown> {
  const lock: unknown = JSON.parse(text);
  if (typeof lock !== "object" || lock === null || !("packages" in lock))
    throw new Error("invalid package lock");
  const packages: unknown = lock.packages;
  if (
    typeof packages !== "object" ||
    packages === null ||
    Array.isArray(packages)
  )
    throw new Error("invalid package lock packages");
  return Object.fromEntries(
    Object.entries(packages).filter(([path]) => path !== ""),
  );
}

async function clean(git: SelfUpdateSettings["git"]): Promise<boolean> {
  const status = await git([
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (status.length > 0) return false;
  return !/^[a-zS] /m.test(await git(["ls-files", "-v"]));
}

async function installRequired(
  git: SelfUpdateSettings["git"],
  update: UpdateCandidate,
): Promise<boolean> {
  try {
    await git([
      "diff",
      "--exit-code",
      update.head,
      update.target,
      "--",
      "package-lock.json",
    ]);
    return false;
  } catch {
    const before = await git(["show", `${update.head}:package-lock.json`]);
    const after = await git(["show", `${update.target}:package-lock.json`]);
    return lockRequiresInstall(before, after);
  }
}

async function candidate(
  settings: SelfUpdateSettings,
): Promise<UpdateCandidate | undefined> {
  const git = settings.git;
  await git(["fetch", "origin"]);
  await git(["remote", "set-head", "origin", "--auto"]);
  const remoteBranch = (
    await git(["symbolic-ref", "refs/remotes/origin/HEAD"])
  ).trim();
  if (!remoteBranch.startsWith("refs/remotes/origin/")) return;
  const branch = remoteBranch.replace("refs/remotes/origin/", "refs/heads/");
  if ((await git(["symbolic-ref", "HEAD"])).trim() !== branch) return;
  const head = (await git(["rev-parse", "HEAD"])).trim();
  const target = (await git(["rev-parse", remoteBranch])).trim();
  if (head === target) {
    await rm(join(settings.directory, "pending-self-update"), { force: true });
    return;
  }
  await git(["merge-base", "--is-ancestor", head, target]);
  if (!(await clean(git))) return;
  if (await settings.active()) {
    await markPending(settings.directory);
    return;
  }
  return { branch, head, target };
}

async function markPending(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `pending-self-update-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${String(Date.now())}\n`, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    await link(temporary, join(directory, "pending-self-update")).catch(
      (error: unknown) => {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        )
          throw error;
      },
    );
  } finally {
    await rm(temporary, { force: true });
  }
}

async function failedTargets(directory: string): Promise<readonly string[]> {
  try {
    return (
      await readFile(join(directory, "failed-self-updates"), "utf8")
    ).split("\n");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
}

async function updated(
  settings: SelfUpdateSettings,
  update: UpdateCandidate,
): Promise<number> {
  await settings.stop();
  try {
    if (!(await clean(settings.git)))
      throw new Error("checkout changed after stop");
    if (
      (await settings.git(["symbolic-ref", "HEAD"])).trim() !== update.branch ||
      (await settings.git(["rev-parse", "HEAD"])).trim() !== update.head
    )
      throw new Error("checkout changed after stop");
    await settings.git([
      "merge",
      "--ff-only",
      "--no-overwrite-ignore",
      update.target,
    ]);
    await rm(join(settings.directory, "pending-self-update"), { force: true });
  } catch (error) {
    settings.error(
      `Self-update failed: ${String(error).replace(/[\r\n]+/g, " ")}\n`,
    );
    await mkdir(settings.directory, { recursive: true });
    await appendFile(
      join(settings.directory, "failed-self-updates"),
      `${update.target}\n`,
    );
  }
  return 75;
}

export function selfUpdater(settings: SelfUpdateSettings): {
  readonly check: () => Promise<number | undefined>;
} {
  let disabled = false;
  let checking = false;
  return {
    check: async () => {
      if (disabled || checking) return;
      checking = true;
      try {
        const update = await candidate(settings).catch(() => undefined);
        if (!update) return;
        if (await installRequired(settings.git, update).catch(() => true)) {
          disabled = true;
          settings.error(
            "Self-update disabled: package-lock.json changed; update and install by hand.\n",
          );
          return;
        }
        const failed = await failedTargets(settings.directory).catch(
          () => undefined,
        );
        if (!failed || failed.includes(update.target)) return;
        disabled = true;
        return await updated(settings, update);
      } finally {
        checking = false;
      }
    },
  };
}
import { randomUUID } from "node:crypto";
import {
  appendFile,
  link,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
