import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRun, ciScenario } from "./github-ci-fixture.ts";

await test("CLV-163 malformed check-run pages fail closed instead of qualifying as no CI", async () => {
  for (const pages of [
    null,
    {},
    [],
    [{}],
    [{ check_runs: "wrong" }],
    [{ check_runs: [{}] }],
    ...[
      { conclusion: 42 },
      { details_url: 42 },
      { app: { slug: 42 } },
      { conclusion: undefined },
      { details_url: undefined },
      { app: undefined },
    ]
      .map((overrides) => ({ check_runs: [checkRun(overrides)] }))
      .map((page) => [page]),
  ])
    await assert.rejects(
      ciScenario({ snapshots: [], pages, timing: { ciGraceMilliseconds: 0 } }),
      /github-call-failed/,
    );
});

await test("CLV-163 check-run pagination includes failures beyond the first page", async () => {
  const { result, calls } = await ciScenario({
    snapshots: [],
    pages: [
      { check_runs: [checkRun()] },
      {
        check_runs: [
          checkRun({
            id: 102,
            name: "quality",
            conclusion: "failure",
            details_url: null,
          }),
        ],
      },
    ],
  });
  assert.equal(result?.reason, "ci-failed");
  assert.ok(result);
  assert.match(result.output, /quality/);
  assert.ok(calls[0]?.includes("--paginate"));
  assert.ok(calls[0]?.includes("--slurp"));
});
