import assert from "node:assert/strict";
import { test } from "node:test";
import { resultOf } from "./claude-worker-fixture.ts";
import { mergeCalls } from "./github-merge-fixture.ts";
import { opened, withGithub } from "./github-worker-fixture.ts";

await test("CLV-163 a failed CI check prevents merging and reports the failed step and log", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    scene.plan({
      scores: [],
      replies: {
        "api GET check-runs": [
          {
            check_runs: [
              {
                id: 101,
                name: "quality_linux",
                app: { slug: "github-actions" },
                status: "completed",
                conclusion: "failure",
                details_url:
                  "https://github.com/acme/demo/actions/runs/88/job/101",
              },
            ],
          },
        ],
      },
    });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    const result = resultOf(report.result);
    assert.equal(result["reason"], "ci-failed");
    assert.match(String(result["output"]), /quality_linux/);
    assert.match(String(result["output"]), /Run quality/);
    assert.match(String(result["output"]), /Failed assertion/);
    assert.deepEqual(mergeCalls(scene), []);
  }));

import { checkRun, ciScenario } from "./github-ci-fixture.ts";

await test("CLV-163 the latest run of each name decides across workflow events", async () => {
  const { result } = await ciScenario({
    snapshots: [
      [
        checkRun({ id: 102 }),
        checkRun({ id: 101, conclusion: "failure" }),
        checkRun({ id: 103, name: "quality", conclusion: "neutral" }),
        checkRun({ id: 104, name: "optional", conclusion: "skipped" }),
        checkRun({
          id: 105,
          app: { slug: "external-reviewer" },
          conclusion: "failure",
        }),
      ],
    ],
  });
  assert.equal(result, undefined);
});

await test("CLV-163 unfinished checks wait for the next poll before allowing merge", async () => {
  const { result, calls, times } = await ciScenario({
    snapshots: [
      [checkRun({ status: "in_progress", conclusion: null })],
      [checkRun()],
    ],
    timing: { pollMilliseconds: 40 },
  });
  assert.equal(result, undefined);
  assert.equal(times.length, 2);
  assert.ok(Number(times[1]) - Number(times[0]) >= 30);
  assert.ok(
    calls.every((call) =>
      call.includes(
        `repos/{owner}/{repo}/commits/${"a".repeat(40)}/check-runs?filter=all&per_page=100`,
      ),
    ),
  );
});

await test("CLV-163 a separate CI deadline blocks with pending check names", async () => {
  const started = Date.now();
  const { result } = await ciScenario({
    snapshots: [[checkRun({ status: "queued", conclusion: null })]],
    timing: { ciLimitMilliseconds: 20, limitMilliseconds: 1 },
    signal: AbortSignal.timeout(500),
  }).catch(() => ({ result: undefined, times: [] }));
  assert.equal(result?.reason, "ci-pending");
  assert.ok(result);
  assert.match(result.output, /quality_linux/);
  assert.ok(Date.now() - started >= 20);
});

await test("CLV-163 repositories without Actions checks wait through the no-CI grace period", async () => {
  const started = Date.now();
  const { result } = await ciScenario({
    snapshots: [
      [],
      [checkRun({ app: { slug: "reviewer" }, conclusion: "failure" })],
    ],
    timing: { ciGraceMilliseconds: 15 },
  });
  assert.equal(result, undefined);
  assert.ok(Date.now() - started >= 15);
});

await test("CLV-163 explicit required checks wait for missing names and ignore unrequired failures", async () => {
  const { result, times } = await ciScenario({
    environment: { CLOVING_REQUIRED_CHECKS: '["quality","external"]' },
    timing: { ciLimitMilliseconds: 20, ciGraceMilliseconds: 0 },
    snapshots: [
      [
        checkRun({
          name: "optional",
          conclusion: "failure",
          details_url: null,
        }),
      ],
    ],
  });
  assert.equal(result?.reason, "ci-pending");
  assert.ok(result);
  assert.match(result.output, /quality.*external/);
  assert.ok(times.length > 1);
});

await test("CLV-163 CI diagnostics hide private texts and keep failed log tails within 6000 characters", async () => {
  const { result } = await ciScenario({
    snapshots: [
      [
        checkRun({ conclusion: "failure" }),
        checkRun({
          id: 102,
          name: "quality",
          conclusion: "timed_out",
          details_url: "https://github.com/acme/demo/actions/runs/88/job/102",
        }),
      ],
    ],
    environment: {
      API_TOKEN: "secret-token",
      CLOVING_PRIVATE_TEXTS: '["private-location"]',
    },
    reply: (parts) =>
      parts.includes("--json")
        ? JSON.stringify({
            jobs: [
              {
                databaseId: 101,
                steps: [
                  { name: "Run private-location", conclusion: "failure" },
                ],
              },
              {
                databaseId: 102,
                steps: [{ name: "Build", conclusion: "failure" }],
              },
            ],
          })
        : `${"irrelevant\n".repeat(1500)}final assertion secret-token private-location`,
  });
  assert.equal(result?.reason, "ci-failed");
  assert.ok(result);
  const output = result.output;
  assert.doesNotMatch(output, /secret-token|private-location/);
  assert.match(output, /quality_linux/);
  assert.match(output, /quality/);
  assert.match(output, /Run \[hidden\]/);
  assert.match(output, /Build/);
  assert.match(output, /final assertion \[hidden\] \[hidden\]/);
  assert.ok(output.length <= 6000);
});

await test("CLV-163 required passing checks of any app allow merging and optional failures are ignored", async () => {
  const { result } = await ciScenario({
    environment: { CLOVING_REQUIRED_CHECKS: '["external","quality_linux"]' },
    snapshots: [
      [
        checkRun(),
        checkRun({
          id: 102,
          name: "external",
          app: { slug: "other" },
          conclusion: "skipped",
        }),
        checkRun({ id: 103, name: "optional", conclusion: "failure" }),
      ],
    ],
  });
  assert.equal(result, undefined);
});

await test("CLV-163 a newer queued run overrides an older success and cancellation stops the wait", async () => {
  const controller = new AbortController();
  let checks = 0;
  await assert.rejects(
    ciScenario({
      snapshots: [
        [checkRun(), checkRun({ id: 102, status: "queued", conclusion: null })],
      ],
      timing: { ciLimitMilliseconds: 1000 },
      signal: controller.signal,
      onCheck: () => {
        checks += 1;
        controller.abort();
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(checks, 1);
});

await test("CLV-163 every completed conclusion outside the passing set fails", async () => {
  for (const conclusion of [
    "cancelled",
    "timed_out",
    "action_required",
    "stale",
    null,
  ]) {
    const { result } = await ciScenario({
      snapshots: [[checkRun({ conclusion, details_url: null })]],
    });
    assert.equal(result?.reason, "ci-failed");
    assert.ok(result);
  }
});

await test("CLV-163 checks that disappear after discovery do not trigger the no-CI grace escape", async () => {
  const { result } = await ciScenario({
    timing: { ciLimitMilliseconds: 15, ciGraceMilliseconds: 0 },
    snapshots: [[checkRun({ status: "queued", conclusion: null })], []],
  });
  assert.equal(result?.reason, "ci-pending");
  assert.ok(result);
});
