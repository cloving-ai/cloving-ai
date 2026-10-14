import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, journalKey, resultOf, until } from "./claude-worker-fixture.ts";
import {
  committed,
  githubIntent,
  withGithub,
  type GithubScene,
  opened,
  pullBody as body,
  pullTitle as title,
  treeOf as tree,
} from "./github-worker-fixture.ts";

const signal = new AbortController().signal;
const pullUrl = "https://github.com/acme/demo/pull/1";

function pushedElsewhere(scene: GithubScene): string {
  const other = join(scene.directory, "other");
  execFileSync("git", ["clone", "--quiet", scene.origin, other], {
    stdio: "ignore",
  });
  git(other, ["config", "user.name", "Cloving Test"]);
  git(other, ["config", "user.email", "test@cloving.invalid"]);
  git(other, ["config", "commit.gpgsign", "false"]);
  const newest = committed(other, { name: "newer.ts", text: "export {};\n" });
  git(other, ["push", "--quiet", "origin", "main"]);
  return newest;
}

function remoteBranch(scene: GithubScene): string {
  return execFileSync(
    "git",
    ["-C", scene.origin, "branch", "--list", "cloving/ticket-one"],
    { encoding: "utf8" },
  ).trim();
}

await test("CLV-063 the GitHub worker makes the work tree of a target from the newest commit of the default branch of origin, and does not change the checkout of the operator", () =>
  withGithub(async (scene) => {
    const newest = pushedElsewhere(scene);
    const before = git(scene.repository, ["rev-parse", "HEAD"]);
    const worker = scene.worker();
    const report = await scene.perform(worker, {
      method: "prepare",
      payload: {},
    });
    assert.equal(report.outcome, "completed");
    assert.deepEqual(resultOf(report.result), {
      branch: "cloving/ticket-one",
      worktree: tree(scene),
      base: "main",
      startCommit: newest,
    });
    assert.deepEqual(
      [
        git(tree(scene), ["rev-parse", "--abbrev-ref", "HEAD"]),
        git(scene.repository, ["rev-parse", "HEAD"]),
        git(scene.repository, ["status", "--short"]),
      ],
      ["cloving/ticket-one", before, ""],
    );
    const again = await scene.perform(worker, {
      method: "prepare",
      payload: {},
    });
    assert.equal(resultOf(again.result)["startCommit"], newest);
  }));

await test("CLV-063 the GitHub worker replies at once with a receipt, keeps a journal per operation, and reports the result with its command and the worker name", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({ document: () => Promise.resolve("{}") });
    const key = journalKey("operation-1");
    assert.deepEqual(await worker.deliver(githubIntent(), signal), {
      receipt: key,
      worker: "github",
    });
    await until(() => scene.reports.length === 1);
    const [report] = scene.reports;
    assert.deepEqual(
      { ...report, result: undefined },
      {
        runId: "run-1",
        commandId: `github:${key}`,
        operationId: "operation-1",
        inputDigest: `sha256:${"a".repeat(64)}`,
        leaseGeneration: 1,
        worker: "github",
        outcome: "completed",
        result: undefined,
      },
    );
    assert.deepEqual(
      ["started.json", "result.json"].map((name) =>
        existsSync(join(scene.journal, key, name)),
      ),
      [true, true],
    );
  }));

await test("CLV-063 the GitHub worker refuses an effect that is not its own, an effect with no payload text, and a payload that is no JSON object", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const { payload, ...unpaid } = githubIntent();
    assert.equal(payload, "sha256:payload-1");
    const refused = [
      githubIntent({ capability: "claude" }),
      githubIntent({ method: "delete-repository" }),
      unpaid,
    ];
    for (const given of refused)
      assert.deepEqual(await worker.deliver(given, signal), {
        kind: "failed",
        reason: "unsupported-effect",
      });
    assert.deepEqual(await worker.deliver(githubIntent(), signal), {
      kind: "failed",
      reason: "payload-not-available",
    });
    for (const text of ["not json", "[1]", "null"])
      assert.deepEqual(
        await scene
          .worker({ document: () => Promise.resolve(text) })
          .deliver(githubIntent(), signal),
        { kind: "failed", reason: "invalid-payload" },
      );
  }));

await test("CLV-063 the GitHub worker pushes the branch and opens one pull request, and a second call pushes the new commits to the same pull request", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    await scene.perform(worker, { method: "prepare", payload: {} });
    const first = committed(tree(scene), { name: "one.ts", text: "1;\n" });
    const call = { method: "open-pr", payload: { title, body } };
    const opening = await scene.perform(worker, call);
    assert.deepEqual(resultOf(opening.result), {
      number: 1,
      url: pullUrl,
      commit: first,
    });
    assert.equal(git(scene.origin, ["rev-parse", "cloving/ticket-one"]), first);
    const second = committed(tree(scene), { name: "two.ts", text: "2;\n" });
    const again = await scene.perform(worker, call);
    assert.deepEqual(resultOf(again.result), {
      number: 1,
      url: pullUrl,
      commit: second,
    });
    assert.equal(
      git(scene.origin, ["rev-parse", "cloving/ticket-one"]),
      second,
    );
    assert.deepEqual(
      scene
        .state()
        .prs.map((pr) => [pr["number"], pr["head"], pr["base"], pr["title"]]),
      [[1, "cloving/ticket-one", "main", title]],
    );
    assert.equal(scene.state().prs[0]?.["body"], body);
  }));

await test("CLV-063 the GitHub worker does not push a branch with no change, or a change that has a private text in a file or in a commit message in any case of letters", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({
      privateTexts: ["", "/home/private-person", "Secret-Word"],
    });
    await scene.perform(worker, { method: "prepare", payload: {} });
    const call = { method: "open-pr", payload: { title, body } };
    const empty = await scene.perform(worker, call);
    assert.deepEqual([empty.outcome, empty.reason], ["failed", "no-change"]);
    committed(tree(scene), {
      name: "notes.ts",
      text: "const notes = '/home/private-person/notes';\n",
    });
    const inFile = await scene.perform(worker, call);
    assert.deepEqual(
      [inFile.outcome, inFile.reason],
      ["failed", "private-path-in-change"],
    );
    git(tree(scene), ["reset", "--quiet", "--hard", "origin/main"]);
    git(tree(scene), [
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "Read /home/private-person/notes",
    ]);
    const inMessage = await scene.perform(worker, call);
    assert.equal(inMessage.reason, "private-path-in-change");
    git(tree(scene), ["reset", "--quiet", "--hard", "origin/main"]);
    committed(tree(scene), {
      name: "word.ts",
      text: "export const word = 'the secret-word';\n",
    });
    const inOtherCase = await scene.perform(worker, call);
    assert.equal(inOtherCase.reason, "private-path-in-change");
    assert.deepEqual([remoteBranch(scene), scene.state().prs], ["", []]);
  }));

await test("CLV-063 the GitHub worker merges the reviewed commit, then removes the remote branch, the work tree and the local branch", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.deepEqual(resultOf(report.result), {
      number: 1,
      merged: "f".repeat(40),
    });
    const merge = scene.state().calls.find((call) => call.includes("PUT"));
    assert.ok(merge?.includes("merge_method=merge"));
    assert.ok(merge?.includes(`sha=${commit}`));
    assert.deepEqual(
      [
        scene.state().prs[0]?.["state"],
        remoteBranch(scene),
        existsSync(tree(scene)),
        git(scene.repository, ["branch", "--list", "cloving/ticket-one"]),
      ],
      ["MERGED", "", false, ""],
    );
  }));

await test("CLV-063 the GitHub worker runs the check command in the work tree before a merge, and does not merge when the check fails", () =>
  withGithub(async (scene) => {
    const check = (code: number): string[] => [
      process.execPath,
      "-e",
      `process.exitCode = process.cwd().endsWith("ticket-one") ? ${String(code)} : 9`,
    ];
    const failing = scene.worker({ check: check(4) });
    const commit = await opened(scene, failing);
    const call = { method: "merge", payload: { number: 1, commit } };
    const refused = await scene.perform(failing, call);
    assert.deepEqual(
      [refused.outcome, refused.reason],
      ["failed", "check-failed"],
    );
    assert.deepEqual(
      [scene.state().prs[0]?.["state"], existsSync(tree(scene))],
      ["OPEN", true],
    );
    const passing = scene.worker({ check: check(0) });
    const merged = await scene.perform(passing, call);
    assert.equal(merged.outcome, "completed");
    assert.equal(scene.state().prs[0]?.["state"], "MERGED");
  }));

await test("CLV-063 the GitHub worker reports a failed call of the gh command and a gh output that is no JSON as failures", () =>
  withGithub(async (scene) => {
    scene.plan({ scores: [], fail: "pr create" });
    const worker = scene.worker();
    await scene.perform(worker, { method: "prepare", payload: {} });
    committed(tree(scene), { name: "one.ts", text: "1;\n" });
    const call = { method: "open-pr", payload: { title, body } };
    const refused = await scene.perform(worker, call);
    scene.plan({ scores: [], garble: "pr list" });
    const garbled = await scene.perform(worker, call);
    assert.deepEqual(
      [refused, garbled].map((report) => [report.outcome, report.reason]),
      [
        ["failed", "github-call-failed"],
        ["failed", "github-call-failed"],
      ],
    );
  }));

await test("CLV-063 the GitHub worker reports a work tree that git cannot make, and a merge of a pull request that GitHub does not have, as failures", () =>
  withGithub(async (scene) => {
    writeFileSync(scene.worktrees, "not a folder");
    const worker = scene.worker();
    const prepared = await scene.perform(worker, {
      method: "prepare",
      payload: {},
    });
    const merged = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit: "1".repeat(40) },
    });
    assert.deepEqual(
      [prepared, merged].map((report) => report.reason),
      ["work-tree-not-available", "github-call-failed"],
    );
  }));

await test("CLV-063 the GitHub worker completes a merge when GitHub refuses to remove the remote branch, and refuses a payload with no pull request number", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    const wrong = await scene.perform(worker, {
      method: "merge",
      payload: { number: "1", commit },
    });
    assert.equal(wrong.reason, "invalid-payload");
    scene.plan({ scores: [], fail: "api DELETE refs" });
    const merged = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.deepEqual(
      [merged.outcome, scene.state().prs[0]?.["state"], remoteBranch(scene)],
      ["completed", "MERGED", "cloving/ticket-one"],
    );
  }));

await test("CLV-063 the GitHub worker reconciles an operation from its journal, and marks an operation that a stopped daemon left as interrupted", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const known = githubIntent({ operationId: "operation-unknown" });
    assert.deepEqual(await worker.reconcile(known, signal), { kind: "absent" });
    const report = await scene.perform(worker, {
      method: "prepare",
      payload: {},
    });
    const done = githubIntent({ operationId: report.operationId });
    const receipt = journalKey(report.operationId);
    assert.deepEqual(await worker.reconcile(done, signal), {
      kind: "completed",
      receipt,
      worker: "github",
      result: report.result,
    });
    assert.deepEqual(await worker.deliver(done, signal), {
      kind: "completed",
      receipt,
      worker: "github",
      result: report.result,
    });
    const left = journalKey("operation-left");
    const folder = join(scene.journal, left);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "started.json"), "{}");
    assert.deepEqual(
      await worker.reconcile(
        githubIntent({ operationId: "operation-left" }),
        signal,
      ),
      {
        kind: "failed",
        receipt: left,
        worker: "github",
        reason: "github-call-interrupted",
      },
    );
    assert.ok(existsSync(join(folder, "result.json")));
  }));
