import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { afterEach, mock, test } from "node:test";
import { promisify } from "node:util";
import { checkRun, ciScenario, workflowRun } from "./github-ci-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

afterEach(() => {
  mock.restoreAll();
});

await test("CLV-258 repeated wildcard filters finish without exponential backtracking", async () => {
  const module = new URL("../src/daemon/github-ci-filters.ts", import.meta.url);
  const source = `
    import { workflowApplies } from ${JSON.stringify(module.href)};
    const pattern = "*a".repeat(30) + "b";
    const context = { branch: "main", paths: ["a".repeat(200)] };
    console.log(JSON.stringify([
      workflowApplies({ paths: [pattern] }, context),
      workflowApplies({ "paths-ignore": [pattern] }, context),
      workflowApplies({ paths: [pattern] }, { ...context, paths: ["a".repeat(200) + "b"] }),
    ]));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", source],
    { timeout: testMilliseconds(2000) },
  );
  assert.deepEqual(JSON.parse(stdout), [false, true, true]);
});

const cases = [
  {
    filters: 'paths-ignore: ["docs/**"]',
    paths: ["docs/a.md"],
    waits: false,
  },
  {
    filters: 'paths-ignore: ["docs/**"]',
    paths: ["docs/a.md", "src/a.ts"],
    waits: true,
  },
  { filters: 'branches: ["release/**"]', branch: "main", waits: false },
  { filters: 'branches: ["release/**"]', branch: "release/v1", waits: true },
  { filters: 'branches-ignore: ["main"]', waits: false },
  {
    filters: 'branches: ["main"]\n    paths: ["src/**"]',
    paths: ["docs/a.md"],
    waits: false,
  },
  {
    filters: 'paths: ["**", "!docs/**"]',
    paths: ["docs/a.md"],
    waits: false,
  },
  {
    filters: 'paths: ["**", "!docs/**", "docs/api/**"]',
    paths: ["docs/api/a.md"],
    waits: true,
  },
  { filters: 'paths: ["docs/**/*.md"]', paths: ["docs/a.md"], waits: true },
  { filters: 'paths: ["*.jsx?"]', paths: ["app.js"], waits: true },
  { filters: 'branches: ["v[12].[0-9]+"]', branch: "v2.123", waits: true },
  { filters: 'paths: ["src/*"]', paths: ["src/nested/a.ts"], waits: false },
  { filters: 'paths: ["src/**"]', paths: [], waits: false },
  { filters: "paths: [42]", waits: true },
];

await test("CLV-258 branch and path filters select only workflows applicable to the pull request", async () => {
  let now = 0;
  mock.method(Date, "now", () => now);
  for (const entry of cases) {
    const started = now;
    const { result } = await ciScenario({
      workflowFiles: {
        ".github/workflows/ci.yml": `on:\n  pull_request:\n    ${entry.filters}\n`,
      },
      baseBranch: entry.branch ?? "main",
      changedPaths: entry.paths ?? ["src/a.ts"],
      snapshots: [[]],
      onCheck: () => {
        now += 30_000;
      },
      timing: { ciLimitMilliseconds: 120_000 },
    });
    assert.equal(
      result?.reason,
      entry.waits ? "ci-pending" : undefined,
      entry.filters,
    );
    assert.equal(now - started, entry.waits ? 120_000 : 60_000, entry.filters);
  }
});

await test("CLV-258 malformed parsed workflow shapes keep waiting for Actions checks", async () => {
  let now = 0;
  mock.method(Date, "now", () => now);
  for (const source of [
    "null",
    "42",
    "[]",
    "jobs: {}",
    "on: {pull_request: {paths: null}}",
  ]) {
    const { result } = await ciScenario({
      workflowFiles: { ".github/workflows/ci.yml": source },
      snapshots: [[]],
      onCheck: () => {
        now += 120_000;
      },
      timing: { ciLimitMilliseconds: 120_000 },
    });
    assert.equal(result?.reason, "ci-pending", source);
  }
});

await test("CLV-258 workflows triggered only by non-head events do not block a passing open PR", async () => {
  let now = 0;
  mock.method(Date, "now", () => now);
  for (const types of ["closed", "labeled", "review_requested"]) {
    const started = now;
    const { result } = await ciScenario({
      workflowFiles: {
        ".github/workflows/ci.yml": "on: pull_request\n",
        ".github/workflows/event.yml": `on: {pull_request: {types: [${types}]}}\n`,
      },
      snapshots: [[checkRun()]],
      workflowSnapshots: [[workflowRun()]],
      onCheck: () => {
        now += 30_000;
      },
      timing: { ciLimitMilliseconds: 120_000 },
    });
    assert.equal(result, undefined);
    assert.equal(now - started, 30_000);
  }
});
