import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfUpdater, type SelfUpdateSettings } from "../tools/self-update.ts";

export const statusCommand =
  "status --porcelain --untracked-files=all --ignore-submodules=none";
export const mergeCommand = "merge --ff-only --no-overwrite-ignore target";
export const lockCommand = "diff --exit-code old target -- package-lock.json";

async function scene() {
  const directory = await mkdtemp(join(tmpdir(), "cloving-update-"));
  const actions: string[] = [];
  const errors: string[] = [];
  const failures = new Map<string, Error>();
  const worker = { active: false };
  const replies: Record<string, string> = {
    "symbolic-ref refs/remotes/origin/HEAD": "refs/remotes/origin/main\n",
    "symbolic-ref HEAD": "refs/heads/main\n",
    "rev-parse HEAD": "old\n",
    "rev-parse refs/remotes/origin/main": "target\n",
    "ls-files -v": "H package-lock.json\n",
  };
  const settings: SelfUpdateSettings = {
    directory,
    git: (argumentsList) => {
      const command = argumentsList.join(" ");
      actions.push(command);
      const error = failures.get(command);
      return error
        ? Promise.reject(error)
        : Promise.resolve(replies[command] ?? "");
    },
    active: () => {
      actions.push("journal");
      return Promise.resolve(worker.active);
    },
    stop: () => {
      actions.push("stop");
      return Promise.resolve();
    },
    error: (line) => {
      errors.push(line);
    },
  };
  return {
    directory,
    actions,
    errors,
    replies,
    failures,
    worker,
    settings,
    updater: selfUpdater(settings),
  };
}

export async function withUpdate(
  action: (fixture: Awaited<ReturnType<typeof scene>>) => Promise<void>,
): Promise<void> {
  const fixture = await scene();
  try {
    await action(fixture);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
}
