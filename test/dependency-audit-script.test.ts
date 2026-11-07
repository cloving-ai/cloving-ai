import assert from "node:assert/strict";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  installTree,
  minimist,
  threeSeverities,
} from "./dependency-audit-fixture.ts";
import {
  abandonedTree,
  loggedCalls,
  moveRemoteDefault,
  runAudit,
  withAuditRepository,
  worktrees,
} from "./dependency-audit-script-fixture.ts";
import { record } from "../src/protocol.ts";

await test("CLV-318 audit-candidates prints the critical and the high advisory of a fixture audit with one of each and a moderate one", () =>
  withAuditRepository(
    { audit: threeSeverities, tree: installTree, issues: [[]] },
    async (place) => {
      const result = await runAudit(place, [place.login]);
      assert.equal(result.status, 0, result.stderr);
      const printed: unknown = JSON.parse(result.stdout);
      assert.ok(Array.isArray(printed));
      assert.deepEqual(
        printed.map((item: unknown) => [
          record(item)?.["name"],
          record(item)?.["severity"],
        ]),
        [
          ["minimist", "critical"],
          ["undici", "high"],
        ],
      );
      const calls = await loggedCalls(place);
      assert.deepEqual(
        calls.map((call) => call.command),
        [
          "npm ci --ignore-scripts --no-audit --no-fund",
          "npm audit --json",
          "npm ls --all --json",
          "gh api --paginate --slurp repos/{owner}/{repo}/issues?state=open&labels=cloving%3A%20security&per_page=100",
        ],
      );
      const tree = calls[0]?.cwd ?? "";
      assert.ok(tree.startsWith(place.temporary), tree);
      assert.match(tree, /\/cloving-audit-[1-9][0-9]*-[^/]+\/tree$/);
      for (const call of calls.slice(0, 3)) {
        assert.equal(call.cwd, tree);
        assert.equal(call.lock, "newest lock\n");
        assert.equal(call.status, "## HEAD (no branch)\n");
      }
      assert.equal(calls[3]?.cwd, place.repository);
      assert.equal(calls[3].github, place.login);
      for (const call of calls.slice(0, 3))
        assert.ok(
          call.github?.startsWith(join(place.command, "gh-config-")),
          call.github ?? "no folder",
        );
      assert.deepEqual(worktrees(place), [`worktree ${place.repository}`]);
      assert.deepEqual(await readdir(place.temporary), []);
    },
  ));

await test("CLV-318 audit-candidates leaves out an advisory that an open security issue names", () =>
  withAuditRepository(
    {
      audit: threeSeverities,
      tree: installTree,
      issues: [[{ number: 9, title: "Fix minimist", body: minimist.url }]],
    },
    async (place) => {
      const result = await runAudit(place, [place.login]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /"name": "undici"/);
      assert.doesNotMatch(result.stdout, /minimist/);
    },
  ));

await test("CLV-318 a failed npm ci prints no candidates, ends with code 1 and removes the work tree", () =>
  withAuditRepository(
    {
      audit: threeSeverities,
      tree: installTree,
      issues: [[]],
      failures: {
        "npm ci --ignore-scripts --no-audit --no-fund":
          "npm error The lock file does not match package.json",
      },
    },
    async (place) => {
      const result = await runAudit(place, [place.login]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        "npm ci --ignore-scripts --no-audit --no-fund failed: npm error The lock file does not match package.json\n",
      );
      assert.deepEqual(worktrees(place), [`worktree ${place.repository}`]);
      assert.deepEqual(await readdir(place.temporary), []);
    },
  ));

await test("CLV-318 audit-candidates audits the default branch of the remote after the old default branch is gone", () =>
  withAuditRepository(
    { audit: threeSeverities, tree: installTree, issues: [[]] },
    async (place) => {
      await moveRemoteDefault(place, "trunk lock\n");
      const result = await runAudit(place, [place.login]);
      assert.equal(result.status, 0, result.stderr);
      const calls = await loggedCalls(place);
      assert.equal(calls[0]?.lock, "trunk lock\n");
      assert.deepEqual(worktrees(place), [`worktree ${place.repository}`]);
    },
  ));

await test("CLV-318 audit-candidates removes the folders and the work trees of earlier audits whose process ended", () =>
  withAuditRepository(
    { audit: threeSeverities, tree: installTree, issues: [[]] },
    async (place) => {
      await abandonedTree(
        place,
        join(place.temporary, "cloving-audit-2147483647-old", "tree"),
      );
      await mkdir(
        join(place.temporary, "cloving-audit-2147483646-gone", "tree"),
        { recursive: true },
      );
      const live = `cloving-audit-${String(process.pid)}-live`;
      for (const name of [live, "other"])
        await mkdir(join(place.temporary, name));
      const result = await runAudit(place, [place.login]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(worktrees(place), [`worktree ${place.repository}`]);
      assert.deepEqual((await readdir(place.temporary)).sort(), [
        live,
        "other",
      ]);
    },
  ));
