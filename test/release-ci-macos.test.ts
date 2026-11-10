import assert from "node:assert/strict";
import { test } from "node:test";
import { job, releaseWorkflow } from "./release-fixture.ts";

await test("a pull request runs only the macOS platform tests, and other events run three full macOS shards", async () => {
  const workflow = await releaseWorkflow();
  const macos = job(workflow, "quality_macos");
  assert.deepEqual(macos.strategy, {
    "fail-fast": false,
    matrix: {
      shard:
        '${{ fromJSON(github.event_name == \'pull_request\' && \'["platform"]\' || \'["1","2","3"]\') }}',
    },
  });
  assert.equal(
    macos.env?.["CLOVING_TEST_SET"],
    "${{ matrix.shard == 'platform' && 'platform' || 'all' }}",
  );
  assert.equal(
    macos.env["CLOVING_TEST_SHARD"],
    "${{ matrix.shard == 'platform' && '1/1' || format('{0}/3', matrix.shard) }}",
  );
  assert.equal(
    job(workflow, "quality_linux_node").env?.["CLOVING_TEST_SET"],
    undefined,
  );
});

await test("coverage joins the macOS platform artifact and the six Linux shard artifacts", async () => {
  const workflow = await releaseWorkflow();
  const coverage = job(workflow, "coverage");
  assert.deepEqual(coverage.needs, ["quality_macos", "quality_linux_node"]);
  assert.equal(coverage["runs-on"], "ubuntu-24.04");
  assert.equal(coverage["timeout-minutes"], 20);
  assert.equal(coverage.if, "${{ github.event_name == 'pull_request' }}");
  const download = coverage.steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  assert.match(
    download?.uses ?? "",
    /^actions\/download-artifact@[a-f0-9]{40}$/,
  );
  assert.deepEqual(download?.with, {
    pattern: "coverage-*",
    path: "${{ runner.temp }}/cloving-coverage",
  });
  const command = coverage.steps.find((step) =>
    step.run?.startsWith("node tools/check-shard-coverage.ts"),
  )?.run;
  const artifacts = ["macos-26.9.0-platform"];
  for (const node of ["24.22.1", "26.9.0"])
    for (const shard of ["1", "2", "3"])
      artifacts.push(`linux-${node}-${shard}`);
  assert.equal(
    command,
    [
      "node tools/check-shard-coverage.ts",
      ...artifacts.map(
        (name) => `"$RUNNER_TEMP/cloving-coverage/coverage-${name}"`,
      ),
    ].join(" "),
  );
});
