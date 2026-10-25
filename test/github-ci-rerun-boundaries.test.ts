import assert from "node:assert/strict";
import filesystem, {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { operationKey } from "../src/daemon/operation-journal.ts";
import { checkRun, ciScenario } from "./github-ci-fixture.ts";

const failed = checkRun({ conclusion: "failure" });
const workflow = { run_attempt: 1, status: "completed" };

await test("CLV-198 a CI deadline reached while persisting the rerun intent prevents the request", async () => {
  let now = 0;
  const rename = filesystem.rename;
  mock.method(Date, "now", () => now);
  mock.method(
    filesystem,
    "rename",
    async (...arguments_: Parameters<typeof rename>) => {
      await rename(...arguments_);
      now = 20;
    },
  );
  syncBuiltinESMExports();
  try {
    const { result, calls } = await ciScenario({
      snapshots: [[failed]],
      workflow: () => workflow,
      timing: { ciLimitMilliseconds: 20 },
    });
    assert.equal(result?.reason, "ci-pending");
    assert.deepEqual(
      calls.filter((call) => call[1] === "rerun"),
      [],
    );
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

await test("CLV-198 failed checks do not start reruns at or after the CI deadline", async () => {
  let now = 0;
  mock.method(Date, "now", () => now);
  try {
    for (const expiresDuring of ["poll", "workflow", "diagnostics"]) {
      now = 0;
      const { result, calls } = await ciScenario({
        snapshots: [[failed]],
        workflow: () => {
          if (expiresDuring === "workflow") now = 20;
          return workflow;
        },
        reply: () => {
          if (expiresDuring === "diagnostics") now = 20;
          return "{}";
        },
        timing: { ciLimitMilliseconds: expiresDuring === "poll" ? 0 : 20 },
      });
      assert.equal(result?.reason, "ci-pending", expiresDuring);
      assert.deepEqual(
        calls.filter((call) => call[1] === "rerun"),
        [],
        expiresDuring,
      );
    }
  } finally {
    mock.restoreAll();
  }
});

await test("CLV-198 newer selected successes supersede a still pending historical rerun", async () => {
  const { result } = await ciScenario({
    snapshots: [
      [failed],
      [
        checkRun({
          id: 202,
          details_url: "https://github.com/acme/demo/actions/runs/99/job/202",
        }),
      ],
    ],
    workflow: () => workflow,
    timing: { ciLimitMilliseconds: 20 },
  });
  assert.equal(result, undefined);
});

await test("CLV-198 a passing required check does not wait for unrelated workflow jobs", async () => {
  let reads = 0;
  const { result } = await ciScenario({
    environment: { CLOVING_REQUIRED_CHECKS: '["quality_linux"]' },
    snapshots: [[failed], [checkRun({ id: 202 })]],
    workflow: () =>
      ++reads === 1 ? workflow : { run_attempt: 2, status: "in_progress" },
    timing: { ciLimitMilliseconds: 20 },
  });
  assert.equal(result, undefined);
});

await test("CLV-198 a fresh second failure starts repair while sibling jobs still run", async () => {
  let reads = 0;
  const { result } = await ciScenario({
    snapshots: [[failed], [checkRun({ id: 202, conclusion: "failure" })]],
    workflow: () =>
      ++reads === 1 ? workflow : { run_attempt: 2, status: "in_progress" },
    timing: { ciLimitMilliseconds: 20 },
  });
  assert.equal(result?.reason, "ci-failed");
});

await test("CLV-198 an unreadable rerun record cannot trigger another request", async () => {
  const folder = await mkdtemp(join(tmpdir(), "cloving-ci-unreadable-"));
  const file = join(folder, `ci-${operationKey("a".repeat(40))}.json`);
  try {
    await writeFile(file, "{}", { mode: 0o000 });
    await assert.rejects(
      ciScenario({
        folder,
        snapshots: [[failed]],
        workflow: () => workflow,
        timing: { ciLimitMilliseconds: 10 },
      }),
    );
  } finally {
    await chmod(file, 0o600);
    await rm(folder, { recursive: true, force: true });
  }
});

await test("CLV-198 a rerun still pending at the CI deadline returns ci-pending with one request", async () => {
  const { result, calls } = await ciScenario({
    snapshots: [[failed]],
    workflow: () => workflow,
    timing: { ciLimitMilliseconds: 20 },
  });
  assert.equal(result?.reason, "ci-pending");
  assert.equal(calls.filter((call) => call[1] === "rerun").length, 1);
});

await test("CLV-198 a completed rerun waits for fresh check results rather than using attempt one's failure", async () => {
  let reads = 0;
  const { result, calls } = await ciScenario({
    snapshots: [[failed]],
    workflow: () => ({ ...workflow, run_attempt: ++reads > 1 ? 2 : 1 }),
    timing: { ciLimitMilliseconds: 20 },
    attemptJobs: [202],
  });
  assert.equal(result?.reason, "ci-pending");
  assert.equal(calls.filter((call) => call[1] === "rerun").length, 1);
});

await test("CLV-198 a stale first-attempt sibling failure is not reported as a second failure", async () => {
  let reads = 0;
  const { result, times } = await ciScenario({
    snapshots: [
      [
        failed,
        checkRun({
          id: 102,
          name: "sibling",
          status: "in_progress",
          conclusion: null,
        }),
      ],
      [
        checkRun({ id: 201 }),
        checkRun({ id: 102, name: "sibling", conclusion: "failure" }),
      ],
      [checkRun({ id: 201 }), checkRun({ id: 202, name: "sibling" })],
    ],
    workflow: () => ({ ...workflow, run_attempt: ++reads === 1 ? 1 : 2 }),
    attemptJobs: [201, 202],
    timing: { ciLimitMilliseconds: 100 },
  });
  assert.equal(result, undefined);
  assert.equal(times.length, 3);
});

await test("CLV-198 an externally started rerun also waits for fresh failed checks", async () => {
  const { result } = await ciScenario({
    snapshots: [[failed]],
    workflow: () => ({ run_attempt: 2, status: "in_progress" }),
    attemptJobs: [202],
    timing: { ciLimitMilliseconds: 20 },
  });
  assert.equal(result?.reason, "ci-pending");
});

await test("CLV-198 two failed checks in a workflow cause only one failed-jobs rerun", async () => {
  let reads = 0;
  const { result, calls } = await ciScenario({
    snapshots: [
      [failed, checkRun({ id: 102, name: "other", conclusion: "failure" })],
      [checkRun(), checkRun({ id: 103, name: "other" })],
    ],
    workflow: () => ({ ...workflow, run_attempt: ++reads > 1 ? 2 : 1 }),
    timing: { ciLimitMilliseconds: 100 },
  });
  assert.equal(result, undefined);
  assert.equal(calls.filter((call) => call[1] === "rerun").length, 1);
});

await test("CLV-198 an unfinished workflow waits before requesting its failed jobs", async () => {
  let reads = 0;
  let now = 0;
  mock.method(Date, "now", () => now);
  try {
    const { result, calls } = await ciScenario({
      snapshots: [[failed]],
      workflow: () => {
        reads += 1;
        now = Math.min(reads - 1, 2) * 10;
        return {
          ...workflow,
          status: reads === 1 ? "in_progress" : "completed",
        };
      },
      reply: (parts) => {
        if (parts[1] === "rerun") now = 20;
        return "{}";
      },
      timing: { ciLimitMilliseconds: 20 },
    });
    assert.equal(result?.reason, "ci-pending");
    assert.equal(reads, 2);
    assert.equal(calls.filter((call) => call[1] === "rerun").length, 1);
    assert.ok(
      calls.findIndex((call) => call[1] === "rerun") >
        calls.findIndex((call) => call[1]?.includes("/actions/runs/88")),
    );
  } finally {
    mock.restoreAll();
  }
});

await test("CLV-198 malformed workflow attempts fail closed without requesting reruns", async () => {
  for (const value of [
    {},
    { run_attempt: 0, status: "completed" },
    { run_attempt: 1.5, status: "completed" },
    { run_attempt: 1, status: null },
  ])
    await assert.rejects(
      ciScenario({ snapshots: [[failed]], workflow: () => value }),
      /github-call-failed/,
    );
});

await test("CLV-198 malformed attempt-job pages cannot establish a second failure", async () => {
  for (const jobPages of [
    null,
    {},
    [],
    [{}],
    [{ jobs: "invalid" }],
    [{ jobs: [{}] }],
  ])
    await assert.rejects(
      ciScenario({ snapshots: [[failed]], jobPages }),
      /github-call-failed/,
    );
});

await test("CLV-198 failed workflows each receive their own single rerun", async () => {
  const { result, calls } = await ciScenario({
    snapshots: [
      [
        failed,
        checkRun({
          id: 301,
          name: "other",
          conclusion: "failure",
          details_url: "https://github.com/acme/demo/actions/runs/99/job/301",
        }),
      ],
      [checkRun({ id: 201 }), checkRun({ id: 302, name: "other" })],
    ],
    workflow: () => workflow,
    timing: { ciLimitMilliseconds: 100 },
  });
  assert.equal(result, undefined);
  assert.deepEqual(
    calls.filter((call) => call[1] === "rerun"),
    [
      ["run", "rerun", "88", "--failed"],
      ["run", "rerun", "99", "--failed"],
    ],
  );
});

await test("CLV-198 both attempt log tails fit the existing diagnostic bound", async () => {
  let reads = 0;
  let logs = 0;
  const { result } = await ciScenario({
    snapshots: [[failed], [checkRun({ id: 202, conclusion: "failure" })]],
    workflow: () => ({ ...workflow, run_attempt: ++reads === 1 ? 1 : 2 }),
    reply: (parts) =>
      parts.includes("--log-failed")
        ? "old output\n".repeat(1000) + `failure-tail-${String(++logs)}`
        : "{}",
  });
  assert.ok(result);
  assert.ok(result.output.length <= 6000);
  assert.match(
    result.output,
    /Attempt 1[\s\S]*failure-tail-1[\s\S]*Attempt 2[\s\S]*failure-tail-2/,
  );
});

await test("CLV-198 restart retains the original CI deadline and malformed records fail closed", async () => {
  const folder = await mkdtemp(join(tmpdir(), "cloving-ci-restart-"));
  const file = join(folder, `ci-${operationKey("a".repeat(40))}.json`);
  try {
    await ciScenario({
      folder,
      snapshots: [[failed]],
      workflow: () => workflow,
      timing: { ciLimitMilliseconds: 10 },
    });
    const saved: unknown = JSON.parse(await readFile(file, "utf8"));
    assert.ok(typeof saved === "object" && saved !== null);
    await writeFile(
      file,
      JSON.stringify({ ...saved, startedAt: Date.now() - 60_000 }),
    );
    const resumed = await ciScenario({
      folder,
      snapshots: [[failed]],
      workflow: () => workflow,
      timing: { ciLimitMilliseconds: 10 },
    });
    assert.equal(resumed.result?.reason, "ci-pending");
    assert.equal(resumed.times.length, 1);
    assert.equal(resumed.calls.filter((call) => call[1] === "rerun").length, 0);
    for (const patch of [
      { commit: "other" },
      { startedAt: "wrong" },
      { reruns: {} },
      ...[
        {},
        { run: 88 },
        { run: "wrong" },
        { run: "88", requestedAt: "wrong" },
        { run: "88", requestedAt: 1, output: null },
      ].map((rerun) => ({ reruns: [rerun] })),
    ]) {
      await writeFile(file, JSON.stringify({ ...saved, ...patch }));
      await assert.rejects(
        ciScenario({ folder, snapshots: [[failed]] }),
        /github-call-failed/,
      );
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
