import {
  assertCheckCoverage,
  checkProject,
  checkProjectTestShard,
  writeProjectReport,
} from "../quality/project.ts";
import { resolve } from "node:path";
import { inspectGenerated } from "../quality/generated-output.ts";
import { proposedModulePolicy } from "../quality/module-policy.ts";
import { checkNpmInputs } from "../quality/npm-inputs.ts";
import { productStepExports } from "../quality/product-steps.ts";
import { parseCheckTimeFactor } from "../quality/test-execution.ts";
import {
  checkTimeWarnings,
  parseTestShard,
  runCommand,
  runSupervisedCommand,
  type CheckTiming,
} from "../quality/command.ts";

const timeFactor = parseCheckTimeFactor(
  process.env["CLOVING_CHECK_TIME_FACTOR"],
);
const shard = process.env["CLOVING_TEST_SHARD"];
const selected = parseTestShard(shard);
const timings: CheckTiming[] = [];
const commandOptions = { timings };

async function shardSources(): Promise<string[]> {
  const output = await runSupervisedCommand(
    {
      check: "static-checks",
      executable: process.execPath,
      arguments: [
        "--max-old-space-size=4096",
        resolve(import.meta.dirname, "check-quality-sources.ts"),
      ],
      directory: process.cwd(),
      timeoutMilliseconds: 600000 * timeFactor,
    },
    commandOptions,
  );
  const report: unknown = JSON.parse(output);
  if (
    !Array.isArray(report) ||
    !report.every((item: unknown) => typeof item === "string")
  )
    throw new Error("invalid-shard-check-report");
  return report;
}

async function checkQuality(): Promise<void> {
  if (!selected || selected.index === 1)
    await checkNpmInputs(process.cwd(), commandOptions);
  if (selected && shard) {
    runCommand(
      {
        check: "test-build",
        executable: "npm",
        arguments: ["run", "build"],
        directory: process.cwd(),
        timeoutMilliseconds: 60000 * timeFactor,
      },
      commandOptions,
    );
    const sources = selected.index === 1 ? await shardSources() : [];
    const generated = await inspectGenerated(process.cwd());
    const result = await checkProjectTestShard(process.cwd(), {
      timeFactor,
      shard,
      coverageDirectory:
        process.env["CLOVING_COVERAGE_DIRECTORY"] ?? "coverage/shard",
      commandOptions,
      generated: generated.outputs,
      architecture: proposedModulePolicy(process.cwd()),
      stepExports: {},
    });
    const completed = [...sources, ...result.completed];
    if (selected.index === 1) assertCheckCoverage(completed);
    const report = {
      ...result,
      completed,
      timings,
      warnings: checkTimeWarnings(timings),
    };
    writeProjectReport(report);
    return;
  }
  const generated = await inspectGenerated(process.cwd());
  const result = await checkProject(process.cwd(), {
    timeFactor,
    commandOptions,
    generated: generated.outputs,
    architecture: proposedModulePolicy(process.cwd()),
    stepExports: await productStepExports(process.cwd()),
  });
  writeProjectReport(result);
}

try {
  await checkQuality();
} catch (error) {
  console.error(error);
  writeProjectReport({ timings, warnings: checkTimeWarnings(timings) });
  process.exitCode = 1;
}
