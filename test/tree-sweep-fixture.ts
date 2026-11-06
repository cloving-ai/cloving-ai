import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredRun } from "../src/record-retention.ts";
import type { TreeSweepSettings } from "../src/daemon/tree-sweep.ts";

export const day = 86_400_000;
export const running = new AbortController().signal;

export interface TreeScene {
  readonly repository: string;
  readonly state: string;
  readonly now: number;
  readonly lines: string[];
  readonly tree: (
    target: string,
    records: readonly { readonly kind: string; readonly runId: string }[],
  ) => Promise<string>;
  readonly born: (target: string, bornAt: number) => Promise<void>;
  readonly archive: (runId: string) => Promise<void>;
  readonly merged: (target: string) => Promise<void>;
  readonly kept: (target: string) => boolean;
  readonly gone: (target: string) => boolean;
  readonly settings: (
    overrides?: Partial<TreeSweepSettings>,
  ) => TreeSweepSettings;
}

export function git(directory: string, parts: readonly string[]): string {
  return execFileSync("git", ["-C", directory, ...parts], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function storedRuns(now: number): Readonly<Record<string, StoredRun>> {
  return {
    failedOld: { status: "failed", endedAt: now - 40 * day },
    cancelledOld: { status: "cancelled", endedAt: now - 40 * day },
    failedRecent: { status: "failed", endedAt: now - 10 * day },
    failedAgain: { status: "failed", endedAt: now - 35 * day },
    completedOld: { status: "completed", endedAt: now - 40 * day },
    active: { status: "running", endedAt: null },
  };
}

async function fakeGh(root: string): Promise<readonly string[]> {
  const script = join(root, "fake-gh.mjs");
  await writeFile(
    script,
    `const head = process.argv[process.argv.indexOf("--head") + 1];
if (head.endsWith("broken")) { process.stderr.write("HTTP 502"); process.exit(1); }
if (head.endsWith("odd")) { process.stdout.write("{}"); process.exit(0); }
if (head.endsWith("slow")) setTimeout(() => process.stdout.write("[]"), 60_000);
else
process.stdout.write(head.endsWith("open") ? '[{"number":7}]' : "[]");
`,
  );
  return [process.execPath, script];
}

function treeName(target: string): string {
  return target.replace("/", "-");
}

async function repositoryAt(root: string): Promise<string> {
  const repository = join(root, "repository");
  await mkdir(repository);
  git(repository, ["init", "--quiet", "--initial-branch", "main"]);
  git(repository, ["config", "user.name", "Cloving Test"]);
  git(repository, ["config", "user.email", "test@cloving.invalid"]);
  git(repository, ["config", "commit.gpgsign", "false"]);
  git(repository, ["commit", "--quiet", "--allow-empty", "-m", "Start"]);
  return repository;
}

async function recordFolder(
  state: string,
  record: {
    readonly kind: string;
    readonly runId: string;
    readonly target: string;
    readonly number: number;
  },
): Promise<string> {
  const { kind, runId, target, number } = record;
  const folder = join(state, kind, `record-${String(number)}`);
  await mkdir(folder, { recursive: true });
  const operationId = JSON.stringify([
    "cloving-operation",
    1,
    runId,
    "turn",
    `operation-${String(number)}`,
  ]);
  await writeFile(
    join(folder, "started.json"),
    JSON.stringify(
      kind === "github"
        ? { operationId, target, runId }
        : {
            operationId,
            target,
            worktree: join(state, "worktrees", treeName(target)),
          },
    ),
  );
  return folder;
}

function present(
  place: { readonly repository: string; readonly state: string },
  target: string,
): readonly boolean[] {
  const name = treeName(target);
  return [
    existsSync(join(place.state, "worktrees", name)),
    git(place.repository, ["branch", "--list", `cloving/${name}`]) !== "",
    existsSync(join(place.state, "attachments", name)),
  ];
}

async function mergedTree(
  place: { readonly repository: string; readonly state: string },
  target: string,
): Promise<void> {
  const name = treeName(target);
  git(place.repository, [
    "worktree",
    "remove",
    "--force",
    join(place.state, "worktrees", name),
  ]);
  git(place.repository, ["branch", "-D", `cloving/${name}`]);
  await rm(join(place.state, "attachments", name), {
    recursive: true,
    force: true,
  });
}

function sceneSettings(place: {
  readonly repository: string;
  readonly state: string;
  readonly gh: readonly string[];
  readonly now: number;
  readonly lines: string[];
}): TreeScene["settings"] {
  const runs = storedRuns(place.now);
  return (overrides = {}) => ({
    directory: place.state,
    repository: place.repository,
    gh: place.gh,
    retention: { days: 30, action: "archive", archiveFolder: null },
    runs: (runIds) =>
      Promise.resolve(
        Object.fromEntries(
          Object.entries(runs).filter(([runId]) => runIds.includes(runId)),
        ),
      ),
    now: () => place.now,
    log: (line) => place.lines.push(line),
    ...overrides,
  });
}

export async function withTrees(body: (scene: TreeScene) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cloving-trees-")));
  const repository = await repositoryAt(root);
  const state = join(root, "state");
  const gh = await fakeGh(root);
  const now = Date.now();
  const lines: string[] = [];
  const folders = new Map<string, string[]>();
  let records = 0;
  const scene: TreeScene = {
    repository,
    state,
    now,
    lines,
    tree: async (target, used) => {
      const path = join(state, "worktrees", treeName(target));
      const branch = `cloving/${treeName(target)}`;
      git(repository, ["worktree", "add", "--quiet", "-b", branch, path]);
      await scene.born(target, now - 50 * day);
      await mkdir(join(state, "attachments", treeName(target)), {
        recursive: true,
      });
      for (const { kind, runId } of used) {
        records += 1;
        const folder = await recordFolder(state, {
          kind,
          runId,
          target,
          number: records,
        });
        folders.set(runId, [...(folders.get(runId) ?? []), folder]);
      }
      return path;
    },
    born: async (target, bornAt) => {
      const link = join(state, "worktrees", treeName(target), ".git");
      await utimes(link, new Date(bornAt), new Date(bornAt));
    },
    archive: async (runId) => {
      for (const folder of folders.get(runId) ?? [])
        await rm(folder, { recursive: true, force: true });
    },
    merged: (target) => mergedTree({ repository, state }, target),
    kept: (target) => present({ repository, state }, target).every(Boolean),
    gone: (target) => !present({ repository, state }, target).some(Boolean),
    settings: sceneSettings({ repository, state, gh, now, lines }),
  };
  try {
    await body(scene);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
