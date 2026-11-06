import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { StoredRun } from "../src/record-retention.ts";
import { treeSweep, type TreeSweepSettings } from "../src/daemon/tree-sweep.ts";

const day = 86_400_000;

interface TreeScene {
  readonly repository: string;
  readonly state: string;
  readonly lines: string[];
  readonly tree: (
    target: string,
    records: readonly { readonly kind: string; readonly runId: string }[],
  ) => Promise<string>;
  readonly kept: (target: string) => boolean;
  readonly gone: (target: string) => boolean;
  readonly settings: (
    overrides?: Partial<TreeSweepSettings>,
  ) => TreeSweepSettings;
}

function git(directory: string, parts: readonly string[]): string {
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
): Promise<void> {
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

async function withTrees(body: (scene: TreeScene) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cloving-trees-")));
  const repository = await repositoryAt(root);
  const state = join(root, "state");
  const gh = await fakeGh(root);
  const now = Date.now();
  const runs = storedRuns(now);
  const lines: string[] = [];
  let records = 0;
  const scene: TreeScene = {
    repository,
    state,
    lines,
    tree: async (target, used) => {
      const path = join(state, "worktrees", treeName(target));
      const branch = `cloving/${treeName(target)}`;
      git(repository, ["worktree", "add", "--quiet", "-b", branch, path]);
      await mkdir(join(state, "attachments", treeName(target)), {
        recursive: true,
      });
      for (const { kind, runId } of used) {
        records += 1;
        await recordFolder(state, { kind, runId, target, number: records });
      }
      return path;
    },
    kept: (target) => present({ repository, state }, target).every(Boolean),
    gone: (target) => !present({ repository, state }, target).some(Boolean),
    settings: (overrides = {}) => ({
      directory: state,
      repository,
      gh,
      retention: { days: 30, action: "archive", archiveFolder: null },
      runs: (runIds) =>
        Promise.resolve(
          Object.fromEntries(
            Object.entries(runs).filter(([runId]) => runIds.includes(runId)),
          ),
        ),
      now: () => now,
      log: (line) => lines.push(line),
      ...overrides,
    }),
  };
  try {
    await body(scene);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await test("CLV-310 the sweep removes the work tree, branch and attachments of an old failed or cancelled run with no open pull request", () =>
  withTrees(async (scene) => {
    await scene.tree("ticket/failed", [
      { kind: "journal", runId: "failedOld" },
    ]);
    await scene.tree("ticket/cancelled", [
      { kind: "journal", runId: "cancelledOld" },
      { kind: "github", runId: "cancelledOld" },
    ]);
    await scene.tree("ticket/failed-open", [
      { kind: "journal", runId: "failedOld" },
    ]);
    await treeSweep(scene.settings()).pass();
    assert.equal(scene.gone("ticket/failed"), true);
    assert.equal(scene.gone("ticket/cancelled"), true);
    assert.equal(scene.kept("ticket/failed-open"), true);
    assert.deepEqual(scene.lines, [
      "retention: removed 2 work trees, kept 1 with an open pull request\n",
    ]);
    assert.doesNotMatch(
      git(scene.repository, ["worktree", "list"]),
      /ticket-(failed|cancelled) /,
    );
  }));

await test("CLV-310 the sweep keeps the work trees of recent, completed, active and unknown runs", () =>
  withTrees(async (scene) => {
    await scene.tree("ticket/recent", [
      { kind: "journal", runId: "failedRecent" },
    ]);
    await scene.tree("ticket/completed", [
      { kind: "journal", runId: "completedOld" },
    ]);
    await scene.tree("ticket/retried", [
      { kind: "journal", runId: "failedOld" },
      { kind: "github", runId: "active" },
    ]);
    await scene.tree("ticket/unknown", [{ kind: "journal", runId: "missing" }]);
    await scene.tree("ticket/none", []);
    await treeSweep(scene.settings()).pass();
    for (const target of [
      "ticket/recent",
      "ticket/completed",
      "ticket/retried",
      "ticket/unknown",
      "ticket/none",
    ])
      assert.equal(scene.kept(target), true, target);
    assert.deepEqual(scene.lines, [
      "retention: removed 0 work trees, kept 0 with an open pull request\n",
    ]);
  }));

await test("CLV-310 the sweep keeps a work tree when the pull request check fails, and keeps all with retention.days null", () =>
  withTrees(async (scene) => {
    await scene.tree("ticket/broken", [
      { kind: "journal", runId: "failedOld" },
    ]);
    await treeSweep(scene.settings()).pass();
    assert.equal(scene.kept("ticket/broken"), true);
    assert.equal(scene.lines.length, 1);
    assert.match(
      scene.lines[0] ?? "",
      /^retention: removed 0 work trees, kept 0 with an open pull request, failed 1 \(ticket\/broken: github-call-failed.*\)\n$/,
    );
    await scene.tree("ticket/failed", [
      { kind: "journal", runId: "failedOld" },
    ]);
    await treeSweep(
      scene.settings({
        retention: { days: null, action: "archive", archiveFolder: null },
      }),
    ).pass();
    assert.equal(scene.kept("ticket/failed"), true);
    assert.equal(scene.lines.length, 1);
  }));

await test("CLV-310 the sweep skips branch targets, records with no run and records with no work tree, and keeps a tree on an invalid GitHub reply", () =>
  withTrees(async (scene) => {
    await scene.tree("ticket/odd", [{ kind: "journal", runId: "failedOld" }]);
    const raw = async (name: string, text: string) => {
      await mkdir(join(scene.state, "journal", name), { recursive: true });
      await writeFile(join(scene.state, "journal", name, "started.json"), text);
    };
    await raw("invalid", "{");
    await raw("no-run", JSON.stringify({ target: "ticket/odd" }));
    await raw(
      "branch",
      JSON.stringify({ target: "branch:feature", runId: "failedOld" }),
    );
    await raw(
      "removed",
      JSON.stringify({ target: "ticket/removed", runId: "failedOld" }),
    );
    await treeSweep(scene.settings()).pass();
    assert.equal(scene.kept("ticket/odd"), true);
    assert.deepEqual(scene.lines, [
      "retention: removed 0 work trees, kept 0 with an open pull request, failed 1 (ticket/odd: github-reply-invalid)\n",
    ]);
  }));

await test("CLV-310 a work tree pass that fails logs the reason", () =>
  withTrees(async (scene) => {
    await scene.tree("ticket/failed", [
      { kind: "journal", runId: "failedOld" },
    ]);
    await treeSweep(
      scene.settings({
        runs: () => Promise.reject(new Error("authority-closed")),
      }),
    ).pass();
    assert.equal(scene.kept("ticket/failed"), true);
    assert.deepEqual(scene.lines, [
      "retention: work trees failed (authority-closed)\n",
    ]);
  }));
