import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  git,
  intent,
  field,
  record,
  resultOf,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";

const signal = new AbortController().signal;
const branch = "feature-search";
const target = `branch:${branch}`;

async function unclean(scene: Scene): Promise<void> {
  await refused(scene, { target, reason: "branch-worktree-not-clean" });
}

async function refused(
  scene: Scene,
  refusal: { readonly target: string; readonly reason: string },
): Promise<void> {
  assert.deepEqual(
    await scene
      .worker("complete")
      .deliver(intent({ target: refusal.target }), signal),
    { kind: "failed", reason: refusal.reason },
  );
  assert.deepEqual(scene.turns(), []);
  assert.equal(existsSync(scene.journal), false);
}

function linked(
  scene: Scene,
  place: { readonly path?: string; readonly branch?: string } = {},
): string {
  const tree = place.path ?? join(scene.directory, "existing tree");
  git(scene.repository, [
    "worktree",
    "add",
    "-b",
    place.branch ?? branch,
    tree,
  ]);
  return tree;
}

await test("CLV-088 a branch target runs and commits in its existing linked work tree and preserves its branch and registration", () =>
  withScene(async (scene) => {
    const tree = linked(scene);
    const worker = scene.worker("complete");
    await worker.deliver(intent({ target }), signal);
    await until(() => scene.reports.length === 1);
    const result = resultOf(scene.reports[0]?.result);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.deepEqual(
      [scene.turns()[0]?.directory, result["worktree"], result["branch"]],
      [tree, tree, branch],
    );
    assert.deepEqual(result["commits"], [
      git(tree, ["log", "-1", "--oneline"]),
    ]);
    assert.equal(
      git(scene.repository, ["rev-parse", `refs/heads/${branch}`]),
      git(tree, ["rev-parse", "HEAD"]),
    );
    assert.ok(
      git(scene.repository, ["worktree", "list", "--porcelain"]).includes(
        `worktree ${tree}\n`,
      ),
    );
  }));

await test("CLV-088 each run keeps its own start commit across turns and worker restarts on the same branch", () =>
  withScene(async (scene) => {
    const tree = linked(scene);
    const initial = git(tree, ["rev-parse", "HEAD"]);
    const starts: string[] = [];
    for (const [index, runId] of ["run-1", "run-2", "run-2"].entries()) {
      starts.push(git(tree, ["rev-parse", "HEAD"]));
      const operationId = `operation-${String(index + 1)}`;
      const worker = scene.worker("committed");
      await worker.deliver(intent({ target, runId, operationId }), signal);
      await until(() => scene.reports.length === index + 1);
      await worker.close();
      assert.equal(scene.reports[index]?.outcome, "completed");
      const start = runId === "run-1" ? initial : starts[1];
      assert.equal(
        field(record(scene, `${operationId}/started.json`), "startCommit"),
        start,
      );
      const result = resultOf(scene.reports[index].result);
      assert.deepEqual(
        result["commits"],
        git(tree, ["log", "--oneline", `${String(start)}..HEAD`]).split("\n"),
      );
      assert.deepEqual(
        result["files"],
        git(tree, ["diff", "--stat", `${String(start)}..HEAD`])
          .split("\n")
          .map((line) => ` ${line.trimStart()}`),
      );
      assert.equal(git(tree, ["status", "--porcelain"]), "");
    }
    assert.equal(
      String(resultOf(scene.reports[1]?.result)["commits"]).split(",").length,
      1,
    );
    assert.equal(
      String(resultOf(scene.reports[2]?.result)["commits"]).split(",").length,
      2,
    );
  }));

await test("CLV-088 a Cloving branch is reserved even outside the managed folder", () =>
  withScene(async (scene) => {
    linked(scene, { branch: "cloving/person" });
    await refused(scene, {
      target: "branch:cloving/person",
      reason: "branch-reserved",
    });
  }));

await test("CLV-088 a work tree in the managed folder is reserved even with a personal branch", () =>
  withScene(async (scene) => {
    linked(scene, { path: join(scene.worktrees, "person") });
    await refused(scene, { target, reason: "branch-reserved" });
  }));

await test("CLV-088 the managed folder itself is reserved", () =>
  withScene(async (scene) => {
    linked(scene, { path: scene.worktrees });
    await refused(scene, { target, reason: "branch-reserved" });
  }));

await test("CLV-088 the reserved folder check resolves symlinks", () =>
  withScene(async (scene) => {
    mkdirSync(scene.worktrees);
    const alias = join(scene.directory, "alias");
    symlinkSync(scene.worktrees, alias);
    linked(scene, { path: join(scene.worktrees, "person") });
    assert.deepEqual(
      await scene
        .worker("complete", { worktrees: alias })
        .deliver(intent({ target }), signal),
      { kind: "failed", reason: "branch-reserved" },
    );
    assert.deepEqual(scene.turns(), []);
  }));

await test("CLV-088 a missing or detached linked work tree cannot supply a branch target", () =>
  withScene(async (scene) => {
    git(scene.repository, ["branch", branch]);
    await refused(scene, { target, reason: "branch-worktree-not-found" });
    git(scene.repository, [
      "worktree",
      "add",
      "--detach",
      join(scene.directory, "detached"),
      branch,
    ]);
    await refused(scene, { target, reason: "branch-worktree-not-found" });
  }));

await test("CLV-088 the main checkout cannot supply a branch target, even when the service repository is linked", () =>
  withScene(async (scene) => {
    const tree = linked(scene);
    for (const repository of [scene.repository, tree]) {
      assert.deepEqual(
        await scene
          .worker("complete", { repository })
          .deliver(intent({ target: "branch:main" }), signal),
        { kind: "failed", reason: "branch-worktree-not-found" },
      );
      assert.deepEqual(scene.turns(), []);
    }
  }));

await test("CLV-088 a registered folder replaced with another repository cannot supply a branch target", () =>
  withScene(async (scene) => {
    const tree = linked(scene);
    renameSync(tree, join(scene.directory, "original-tree"));
    git(scene.directory, ["clone", "--no-local", scene.repository, tree]);
    git(tree, ["checkout", branch]);
    await refused(scene, { target, reason: "branch-worktree-not-found" });
  }));

await test("CLV-088 a dirty branch work tree refuses the effect before the command runs", () =>
  withScene(async (scene) => {
    const tree = linked(scene);
    writeFileSync(join(tree, "README.md"), "An uncommitted edit.\n");
    await unclean(scene);
  }));

await test("CLV-088 a large index is checked completely without an output buffer limit", () =>
  withScene(async (scene) => {
    const tree = linked(scene);
    const directory = join(...Array<string>(4).fill("folder".repeat(30)));
    mkdirSync(join(tree, directory), { recursive: true });
    for (let index = 0; index < 1800; index += 1)
      writeFileSync(
        join(tree, directory, `${String(index)}.txt`),
        "Tracked.\n",
      );
    git(tree, ["add", "."]);
    git(tree, ["commit", "--quiet", "-m", "Add a large index"]);
    const listing = execFileSync("git", ["-C", tree, "ls-files", "-v", "-z"], {
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.ok(listing.length > 1024 * 1024);
    const worker = scene.worker("bare");
    assert.equal(
      field(await worker.deliver(intent({ target }), signal), "worker"),
      "claude",
    );
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    git(tree, ["update-index", "--skip-worktree", join(directory, "999.txt")]);
    assert.deepEqual(
      await worker.deliver(
        intent({ target, operationId: "operation-2" }),
        signal,
      ),
      { kind: "failed", reason: "branch-worktree-not-clean" },
    );
    assert.equal(scene.turns().length, 1);
  }));

for (const bit of ["assume-unchanged", "skip-worktree"]) {
  await test(`CLV-088 a changed file hidden by ${bit} refuses the effect`, () =>
    withScene(async (scene) => {
      const tree = linked(scene);
      git(tree, ["update-index", `--${bit}`, "README.md"]);
      writeFileSync(join(tree, "README.md"), "Hidden edit.\n");
      assert.equal(git(tree, ["status", "--porcelain"]), "");
      await unclean(scene);
    }));
  await test(`CLV-088 even an unchanged file with ${bit} refuses the effect`, () =>
    withScene(async (scene) => {
      const tree = linked(scene);
      git(tree, ["update-index", `--${bit}`, "README.md"]);
      await unclean(scene);
    }));
}

await test("CLV-088 untracked files are checked despite status.showUntrackedFiles=no", () =>
  withScene(async (scene) => {
    const tree = linked(scene);
    git(tree, ["config", "status.showUntrackedFiles", "no"]);
    writeFileSync(join(tree, "untracked.txt"), "Untracked.\n");
    assert.equal(git(tree, ["status", "--porcelain"]), "");
    await unclean(scene);
  }));

await test("CLV-088 executable changes are checked despite core.fileMode=false", () =>
  withScene(async (scene) => {
    const tree = linked(scene);
    git(tree, ["config", "core.fileMode", "false"]);
    chmodSync(join(tree, "README.md"), 0o755);
    assert.equal(git(tree, ["status", "--porcelain"]), "");
    await unclean(scene);
  }));

await test("CLV-088 a changed tracked submodule file is checked despite ignore=all", () =>
  withScene(async (scene) => {
    const tree = linked(scene);
    git(tree, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      scene.repository,
      "module",
    ]);
    git(tree, ["commit", "-m", "Add the submodule"]);
    git(tree, ["config", "submodule.module.ignore", "all"]);
    writeFileSync(join(tree, "module", "README.md"), "Submodule edit.\n");
    assert.equal(git(tree, ["status", "--porcelain"]), "");
    await unclean(scene);
  }));
