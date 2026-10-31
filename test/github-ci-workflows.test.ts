import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { calls } from "../src/daemon/github-calls.ts";
import { pullRequestWorkflows } from "../src/daemon/github-ci-workflows.ts";
import { git } from "./claude-worker-fixture.ts";
import { checkRun, ciScenario, workflowRun } from "./github-ci-fixture.ts";
import { advancedBase } from "./github-merge-fixture.ts";
import { opened, withGithub } from "./github-worker-fixture.ts";

afterEach(() => {
  mock.restoreAll();
});

await test("CLV-258 workflow path selection fetches a base that moves after the last fetch", () =>
  withGithub(async (scene) => {
    const workflows = join(scene.repository, ".github/workflows");
    mkdirSync(workflows, { recursive: true });
    writeFileSync(
      join(workflows, "ci.yml"),
      'on: {pull_request: {paths: ["src/**"]}}\n',
    );
    git(scene.repository, ["add", ".github/workflows"]);
    git(scene.repository, ["commit", "-qm", "Add the workflow"]);
    git(scene.repository, ["push", "--quiet", "origin", "main"]);
    const commit = await opened(scene, scene.worker());
    const stale = join(scene.directory, "stale");
    execFileSync("git", ["clone", "--quiet", scene.origin, stale]);
    const base = advancedBase(scene);
    assert.throws(() =>
      execFileSync("git", ["cat-file", "-e", base], {
        cwd: stale,
        stdio: "ignore",
      }),
    );
    const signal = new AbortController().signal;
    const settings = {
      repository: stale,
      worktrees: scene.worktrees,
      gh: ["fake-gh"],
    };
    const paths = await pullRequestWorkflows(
      {
        target: "ticket/one",
        payload: { number: 1 },
        folder: join(scene.directory, "ci"),
        signal,
        settings,
        calls: {
          ...calls(settings, signal),
          gh: () =>
            Promise.resolve(
              JSON.stringify({ base: { sha: base, ref: "main" } }),
            ),
        },
      },
      commit,
    );
    assert.deepEqual(paths, [".github/workflows/ci.yml"]);
  }));

await test("CLV-258 workflow filenames containing an at sign retain their identity", async () => {
  let now = 0;
  mock.method(Date, "now", () => now);
  const { result } = await ciScenario({
    workflowFiles: {
      ".github/workflows/ci@2.yml": "on: pull_request\n",
      ".github/workflows/ci.yml": "on: pull_request\n",
      ".github/workflows/ci.yml@extra.yml": "on: pull_request\n",
    },
    snapshots: [[checkRun()]],
    workflowSnapshots: [
      [
        workflowRun({ path: ".github/workflows/ci@2.yml@refs/heads/main" }),
        workflowRun({ path: ".github/workflows/ci.yml" }),
        workflowRun({
          path: ".github/workflows/ci.yml@extra.yml@refs/heads/main",
        }),
      ],
    ],
    onCheck: () => {
      now += 60_000;
    },
    timing: { ciLimitMilliseconds: 120_000 },
  });
  assert.equal(result, undefined);
});

await test("CLV-258 other heads, events and older successful runs cannot satisfy an expected workflow", async () => {
  let now = 0;
  mock.method(Date, "now", () => now);
  for (const runs of [
    [workflowRun({ head_sha: "b".repeat(40) })],
    [workflowRun({ event: "push" })],
    [
      workflowRun(),
      workflowRun({ id: 89, status: "queued", conclusion: null }),
    ],
    [workflowRun({ status: "in_progress", conclusion: null })],
    [workflowRun({ conclusion: "failure" })],
  ]) {
    const { result } = await ciScenario({
      workflowFiles: { ".github/workflows/ci.yml": "on: pull_request\n" },
      snapshots: [[checkRun()]],
      workflowSnapshots: [runs],
      onCheck: () => {
        now += 60_000;
      },
      timing: { ciLimitMilliseconds: 120_000 },
    });
    assert.equal(result?.reason, "ci-pending");
    assert.match(result.output, /waiting for GitHub Actions checks/);
  }
});

await test("CLV-258 workflow pages use the exact head, PR event and workflow file identity", async () => {
  const { result, calls } = await ciScenario({
    workflowFiles: {
      ".github/workflows/ci.yml": "on: pull_request\n",
      ".github/workflows/fast.yml": "on: pull_request\n",
    },
    snapshots: [[checkRun()]],
    workflowPages: [
      {
        workflow_runs: [
          workflowRun({ path: ".github/workflows/ci.yml@refs/heads/main" }),
        ],
      },
      {
        workflow_runs: [
          workflowRun({ id: 89, path: ".github/workflows/fast.yml" }),
        ],
      },
    ],
  });
  assert.equal(result, undefined);
  assert.ok(
    calls.some(
      (parts) =>
        parts.includes("--paginate") &&
        parts.includes("--slurp") &&
        parts.includes(
          `repos/{owner}/{repo}/actions/runs?head_sha=${"a".repeat(40)}&event=pull_request&per_page=100`,
        ),
    ),
  );
});

await test("CLV-258 malformed workflow pages fail closed", async () => {
  for (const workflowPages of [
    null,
    [],
    [{}],
    [{ workflow_runs: [null] }],
    [{ workflow_runs: [{ id: 88 }] }],
  ]) {
    await assert.rejects(
      ciScenario({
        workflowFiles: { ".github/workflows/ci.yml": "on: pull_request\n" },
        snapshots: [[checkRun()]],
        workflowPages,
      }),
      /github-call-failed/,
    );
  }
});
