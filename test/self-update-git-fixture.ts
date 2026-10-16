import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function repositoryGit(
  repository: string,
): (argumentsList: readonly string[]) => string {
  return (argumentsList) =>
    execFileSync("git", ["-C", repository, ...argumentsList], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

export async function withUpdateRepository(
  action: (fixture: {
    readonly root: string;
    readonly repository: string;
    readonly old: string;
    readonly target: string;
    readonly git: ReturnType<typeof repositoryGit>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cloving-update-git-"));
  const repository = join(root, "repository");
  const git = repositoryGit(repository);
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repository]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.invalid"]);
    await writeFile(join(repository, ".gitignore"), "collision.txt\n");
    await writeFile(join(repository, "package-lock.json"), "{}\n");
    git(["add", "."]);
    git(["commit", "-qm", "Base"]);
    const old = git(["rev-parse", "HEAD"]);
    const origin = join(root, "origin.git");
    execFileSync("git", ["clone", "-q", "--bare", repository, origin]);
    git(["remote", "add", "origin", origin]);
    await writeFile(join(repository, "collision.txt"), "remote contents\n");
    git(["add", "--force", "collision.txt"]);
    git(["commit", "-qm", "Target"]);
    const target = git(["rev-parse", "HEAD"]);
    git(["push", "-q", "origin", "main"]);
    git(["reset", "--hard", old]);
    git(["fetch", "-q", "origin"]);
    git(["remote", "set-head", "origin", "main"]);
    await action({ root, repository, old, target, git });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
