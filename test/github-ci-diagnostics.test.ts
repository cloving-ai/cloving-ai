import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRun, ciScenario, runningRunReply } from "./github-ci-fixture.ts";

await test("CLV-163 failed steps use the Actions job ID from the check details URL", async () => {
  const { result } = await ciScenario({
    snapshots: [[checkRun({ id: 987, conclusion: "failure" })]],
    reply: (parts) =>
      parts.includes("--json")
        ? JSON.stringify({
            jobs: [
              {
                databaseId: 101,
                name: "quality_linux",
                steps: [{ name: "Run quality", conclusion: "failure" }],
              },
            ],
          })
        : "assertion failed",
  });
  assert.ok(result);
  assert.match(result.output, /Failed step: Run quality/);
});

await test("CLV-163 unavailable logs preserve the CI failure and other failed checks", async () => {
  const { result } = await ciScenario({
    snapshots: [
      [
        checkRun({ conclusion: "failure" }),
        checkRun({ id: 102, name: "quality", conclusion: "cancelled" }),
      ],
    ],
    reply: () => {
      throw Object.assign(new Error("github-call-failed"), {
        detail: "logs expired",
      });
    },
  });
  assert.equal(result?.reason, "ci-failed");
  assert.ok(result);
  assert.match(result.output, /quality_linux/);
  assert.match(result.output, /quality/);
  assert.match(result.output, /logs expired/);
});

await test("CLV-163 a failed job retains its log while a sibling is still running", async () => {
  const { result, calls } = await ciScenario({
    snapshots: [
      [
        checkRun({ conclusion: "failure" }),
        checkRun({
          id: 102,
          name: "sibling",
          status: "in_progress",
          conclusion: null,
        }),
      ],
    ],
    reply: runningRunReply,
  });
  assert.ok(result);
  assert.equal(result.reason, "ci-failed");
  assert.match(result.output, /failed job assertion/);
  assert.ok(
    calls.some((call) =>
      call.includes("repos/{owner}/{repo}/actions/jobs/101/logs"),
    ),
  );
});

await test("CLV-163 failed checks in one run retain separate job log tails", async () => {
  const { result } = await ciScenario({
    snapshots: [
      [
        checkRun({ conclusion: "failure" }),
        checkRun({
          id: 102,
          name: "quality",
          conclusion: "failure",
          details_url: "https://github.com/acme/demo/actions/runs/88/job/102",
        }),
      ],
    ],
    reply: (parts) =>
      parts.includes("--json")
        ? "{}"
        : `${"old line\n".repeat(1200)}${parts.includes("101") ? "linux-failure-tail" : "other-failure-tail"}`,
  });
  assert.ok(result);
  assert.match(result.output, /linux-failure-tail/);
  assert.match(result.output, /other-failure-tail/);
  assert.ok(result.output.length <= 6000);
});

await test("CLV-163 CI diagnostics hide private texts in every letter case", async () => {
  const { result } = await ciScenario({
    snapshots: [[checkRun({ name: "ACME[OPS]", conclusion: "failure" })]],
    environment: {
      API_TOKEN: "ExactToken",
      CLOVING_PRIVATE_TEXTS: '["Acme[Ops]"]',
    },
    reply: (parts) =>
      parts.includes("--json")
        ? JSON.stringify({
            jobs: [
              {
                databaseId: 101,
                steps: [{ name: "Build acme[ops]", conclusion: "failure" }],
              },
            ],
          })
        : "Failed AcMe[OpS] ExactToken exacttoken",
  });
  assert.ok(result);
  assert.equal(result.reason, "ci-failed");
  assert.doesNotMatch(result.output, /acme\[ops\]/i);
  assert.match(result.output, /Failed check: \[hidden\]/);
  assert.match(result.output, /Failed step: Build \[hidden\]/);
  assert.match(result.output, /Failed \[hidden\] \[hidden\] exacttoken/);
});
