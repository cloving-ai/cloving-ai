import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  gateRun,
  releaseWorkflow,
  reportFolderRun,
  steps,
} from "./release-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const failed = "${{ failure() }}";
const reportFolder = "${{ steps.test-report.outputs.directory }}";
const shards = [
  ["quality_macos", "test-report-macos-26.9.0-${{ matrix.shard }}"],
  [
    "quality_linux_node",
    "test-report-linux-${{ matrix.node }}-${{ matrix.shard }}",
  ],
] as const;
const failedGate = `import { reportTestFailures } from ${JSON.stringify(
  pathToFileURL(join(import.meta.dirname, "../quality/test-failures.ts")).href,
)};
reportTestFailures({ failures: [{ name: "failed", message: "cause", stderr: [] }] }, "{}");`;

await test("CLV-353 a failed shard uploads its full test report for 7 days with the pinned upload action, also in a rerun", async () => {
  const workflow = await releaseWorkflow();
  for (const [name, artifact] of shards) {
    const jobSteps = steps(workflow, name);
    const gate = jobSteps.findIndex((step) => step.run === gateRun);
    const folder = jobSteps.findIndex((step) => step.id === "test-report");
    const upload = jobSteps.findIndex(
      (step) => step.with?.["name"] === artifact,
    );
    assert.ok(gate >= 0 && gate < folder && folder < upload, name);
    assert.equal(jobSteps[folder]?.if, failed);
    assert.equal(jobSteps[folder].run, reportFolderRun);
    assert.equal(jobSteps[upload]?.if, failed);
    const coverage = jobSteps.find((step) =>
      String(step.with?.["name"]).startsWith("coverage-"),
    );
    assert.match(
      coverage?.uses ?? "",
      /^actions\/upload-artifact@[a-f0-9]{40}$/,
    );
    assert.equal(jobSteps[upload].uses, coverage?.uses);
    assert.deepEqual(jobSteps[upload].with, {
      name: artifact,
      path: `${reportFolder}/cloving-test-report-*.json`,
      "if-no-files-found": "ignore",
      "retention-days": 7,
      overwrite: true,
    });
  }
});

await test("CLV-353 the upload path finds the report that a failed gate writes", async () => {
  const workflow = await releaseWorkflow();
  await withFiles({}, (directory) => {
    const environment = { PATH: process.env["PATH"] ?? "", TMPDIR: directory };
    const gate = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", failedGate],
      { env: environment, encoding: "utf8", timeout: testMilliseconds(10000) },
    );
    const report =
      /^Error: test-report-failure\. Full test report: (\S+)$/m.exec(
        gate.stderr,
      )?.[1];
    assert.ok(report, gate.stderr);
    for (const [name, artifact] of shards) {
      const jobSteps = steps(workflow, name);
      const run = jobSteps.find((step) => step.id === "test-report")?.run;
      assert.ok(typeof run === "string", name);
      const output = join(directory, `${name}.output`);
      const found = spawnSync(
        "/bin/bash",
        ["-e", "-o", "pipefail", "-c", run],
        {
          env: { ...environment, GITHUB_OUTPUT: output },
          encoding: "utf8",
          timeout: testMilliseconds(10000),
        },
      );
      assert.equal(found.status, 0, found.stderr);
      const folder = /^directory=(.+)$/m.exec(readFileSync(output, "utf8"));
      assert.ok(folder?.[1], name);
      const path = jobSteps.find((step) => step.with?.["name"] === artifact)
        ?.with?.["path"];
      assert.ok(typeof path === "string", name);
      assert.deepEqual(globSync(path.replace(reportFolder, folder[1])), [
        report,
      ]);
    }
  });
});
