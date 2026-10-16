export interface SelfUpdateSettings {
  readonly directory: string;
  readonly git: (argumentsList: readonly string[]) => Promise<string>;
  readonly active: () => Promise<boolean>;
  readonly stop: () => Promise<void>;
  readonly error: (line: string) => void;
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

async function candidate(
  settings: SelfUpdateSettings,
): Promise<{ readonly head: string; readonly target: string } | undefined> {
  const git = settings.git;
  await git(["fetch", "origin"]);
  await git(["remote", "set-head", "origin", "--auto"]);
  const branch = (
    await git(["symbolic-ref", "refs/remotes/origin/HEAD"])
  ).trim();
  if (!branch.startsWith("refs/remotes/origin/")) return;
  if (
    (await git(["symbolic-ref", "HEAD"])).trim() !==
    branch.replace("refs/remotes/origin/", "refs/heads/")
  )
    return;
  const head = (await git(["rev-parse", "HEAD"])).trim();
  const target = (await git(["rev-parse", branch])).trim();
  if (head === target) return;
  await git(["merge-base", "--is-ancestor", head, target]);
  if (!(await clean(git))) return;
  if (await settings.active()) return;
  return { head, target };
}

async function failedTargets(directory: string): Promise<readonly string[]> {
  try {
    return (
      await readFile(join(directory, "failed-self-updates"), "utf8")
    ).split("\n");
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "ENOENT") return [];
    throw error;
  }
}

async function updated(
  settings: SelfUpdateSettings,
  target: string,
): Promise<number> {
  await settings.stop();
  try {
    if (!(await clean(settings.git)))
      throw new Error("checkout changed after stop");
    await settings.git(["merge", "--ff-only", "--no-overwrite-ignore", target]);
  } catch (error) {
    settings.error(
      `Self-update failed: ${String(error).replace(/[\r\n]+/g, " ")}\n`,
    );
    await mkdir(settings.directory, { recursive: true });
    await appendFile(
      join(settings.directory, "failed-self-updates"),
      `${target}\n`,
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
        try {
          await settings.git([
            "diff",
            "--exit-code",
            update.head,
            update.target,
            "--",
            "package-lock.json",
          ]);
        } catch {
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
        return await updated(settings, update.target);
      } finally {
        checking = false;
      }
    },
  };
}
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
