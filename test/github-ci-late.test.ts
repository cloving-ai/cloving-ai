import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { checkRun, ciScenario } from "./github-ci-fixture.ts";

afterEach(() => {
  mock.restoreAll();
});

await test("CLV-258 a pull-request workflow still waits after two minutes without checks", async () => {
  let now = 0;
  mock.method(Date, "now", () => now);
  const { result, times } = await ciScenario({
    workflowFiles: { ".github/workflows/ci.yml": "on: pull_request\n" },
    snapshots: [[]],
    onCheck: () => {
      now += 30_000;
    },
    timing: { ciLimitMilliseconds: 120_000 },
  });
  assert.equal(result?.reason, "ci-pending");
  assert.match(result.output, /waiting for GitHub Actions checks/);
  assert.deepEqual(times, [0, 30_000, 60_000, 90_000]);
});

await test("CLV-258 pull-request triggers and unreadable workflows require a check run", async () => {
  let now = 0;
  mock.method(Date, "now", () => now);
  for (const source of [
    '"on": [push, "pull_request"]\n',
    "'on':\n  push:\n  pull_request:\n    branches: [main]\njobs: {}\n",
    "on:\n- push\n- pull_request\n",
    "on: {push: {}, pull_request: {}}\n",
    "events: &events [push, pull_request]\non: *events\n",
    'on: "pull_\\u0072equest"\n',
    "name: &event pull_request\non:\n  - *event\njobs: {}\n",
    '{"on": ["pull_request"], "jobs": {}}\n',
    "  on: pull_request\n  jobs: {}\n",
    '{"on":{"pull_request":null},"jobs":{}}\n',
    "{on: pull_request, jobs: {}}\n",
    "---\n  on: pull_request\n  jobs: {}\n",
    "<<: {on: pull_request}\njobs: {}\n",
    "on: [push,\npull_request]\njobs: {}\n",
    "on: {push: {},\npull_request: {}}\njobs: {}\n",
    'on: {push: {paths: ["foo # bar"]}, pull_request: {}}\n',
    "on:\n  push: {\nbranches: [main]}\n  pull_request:\njobs: {}\n",
    "on: [pull_request\n",
    "on: *unknown\n",
    "on: null\n",
    "on: 42\n",
  ]) {
    const { result } = await ciScenario({
      workflowFiles: { ".github/workflows/ci.yaml": source },
      snapshots: [[]],
      onCheck: () => {
        now += 120_000;
      },
      timing: { ciLimitMilliseconds: 120_000 },
    });
    assert.equal(result?.reason, "ci-pending", source);
  }
});

await test("CLV-258 checks created after five minutes must finish before the wait returns", async () => {
  let now = 0;
  mock.method(Date, "now", () => now);
  const { result, times } = await ciScenario({
    workflowFiles: { ".github/workflows/ci.yml": "on: pull_request\n" },
    snapshots: [
      [],
      [],
      [],
      [],
      [],
      [checkRun({ status: "queued", conclusion: null })],
      [checkRun({ status: "in_progress", conclusion: null })],
      [checkRun()],
    ],
    onCheck: () => {
      now += 60_000;
    },
  });
  assert.equal(result, undefined);
  assert.deepEqual(
    times,
    [0, 60_000, 120_000, 180_000, 240_000, 300_000, 360_000, 420_000],
  );
});

await test("CLV-258 no workflows retain the sixty-second grace", async () => {
  let now = 0;
  mock.method(Date, "now", () => now);
  const { result, times } = await ciScenario({
    snapshots: [[]],
    onCheck: () => {
      now += 30_000;
    },
  });
  assert.equal(result, undefined);
  assert.deepEqual(times, [0, 30_000]);
});

await test("CLV-258 pull-request text outside the trigger does not remove the grace", async () => {
  let now = 0;
  mock.method(Date, "now", () => now);
  const { result } = await ciScenario({
    workflowFiles: {
      ".github/workflows/push.yml":
        "# on: pull_request\non: push # pull_request\njobs:\n  pull_request:\n    runs-on: ubuntu-latest\n",
      ".github/workflows/target.yaml": "on: pull_request_target\n",
    },
    snapshots: [[]],
    onCheck: () => {
      now += 30_000;
    },
    timing: { ciLimitMilliseconds: 120_000 },
  });
  assert.equal(result, undefined);
  assert.equal(now, 60_000);
});

await test("CLV-258 indented and JSON manual workflows keep the grace despite pull-request job names", async () => {
  let now = 0;
  mock.method(Date, "now", () => now);
  for (const source of [
    "  on: workflow_dispatch\n  jobs:\n    pull_request:\n      runs-on: ubuntu-latest\n",
    '{"on":"workflow_dispatch","jobs":{"pull_request":{}}}\n',
    'on: "push"\njobs:\n  pull_request: {}\n',
    "on:\n  push:\n    branches: [pull_request]\njobs: {}\n",
    "on: {push: {branches: [pull_request]}}\njobs: {}\n",
    "on: [push,\n  workflow_dispatch]\njobs: {}\n",
    "{on: workflow_dispatch, jobs: {}}\n",
  ]) {
    const started = now;
    const { result } = await ciScenario({
      workflowFiles: { ".github/workflows/manual.yml": source },
      snapshots: [[]],
      onCheck: () => {
        now += 30_000;
      },
      timing: { ciLimitMilliseconds: 120_000 },
    });
    assert.equal(result, undefined, source);
    assert.equal(now - started, 60_000);
  }
});

await test("CLV-258 the default ninety-minute limit reports missing Actions checks", async () => {
  let now = 0;
  mock.method(Date, "now", () => now);
  const { result } = await ciScenario({
    workflowFiles: { ".github/workflows/ci.yml": "on: pull_request\n" },
    snapshots: [[]],
    onCheck: () => {
      now += 60_000;
    },
  });
  assert.equal(now, 5_400_000);
  assert.equal(result?.reason, "ci-pending");
  assert.match(
    result.output,
    /Pending checks: waiting for GitHub Actions checks$/,
  );
});

await test("CLV-258 configured required checks retain their behavior without workflow discovery", async () => {
  for (const requiredChecks of [[], ["quality_linux"]]) {
    const { result, gitCalls } = await ciScenario({
      requiredChecks,
      workflowFiles: { ".github/workflows/ci.yml": "on: pull_request\n" },
      snapshots: [[checkRun()]],
    });
    assert.equal(result, undefined);
    assert.deepEqual(gitCalls, []);
  }
  const { result } = await ciScenario({
    requiredChecks: ["missing"],
    snapshots: [[checkRun()]],
    timing: { ciLimitMilliseconds: 10 },
  });
  assert.equal(result?.reason, "ci-pending");
  assert.match(result.output, /Pending checks: missing$/);
});

await test("CLV-258 discovery reads workflow files from the exact head and ignores other files", async () => {
  const { result, gitCalls } = await ciScenario({
    workflowFiles: {
      ".github/workflows/README.md": "on: pull_request\n",
      ".github/workflows/nested/ignored.yml": "on: pull_request\n",
      ".github/workflows/manual.yml": "on: workflow_dispatch\n",
      ".github/workflows/ci.yaml": "on: pull_request\n",
    },
    snapshots: [[checkRun()]],
  });
  const head = "a".repeat(40);
  assert.equal(result, undefined);
  assert.deepEqual(gitCalls, [
    ["ls-tree", "-r", "--name-only", "-z", head, "--", ".github/workflows"],
    ["show", `${head}:.github/workflows/manual.yml`],
    ["show", `${head}:.github/workflows/ci.yaml`],
  ]);
});
