import { checkProject, writeProjectReport } from "../quality/project.ts";
import { inspectGenerated } from "../quality/generated-output.ts";
import { proposedModulePolicy } from "../quality/module-policy.ts";
import { checkNpmInputs } from "../quality/npm-inputs.ts";
import { productStepExports } from "../quality/product-steps.ts";
import { parseCheckTimeFactor } from "../quality/test-execution.ts";
import {
  checkTimeWarnings,
  parseTestShard,
  runCommand,
  type CheckTiming,
} from "../quality/command.ts";

const timeFactor = parseCheckTimeFactor(
  process.env["CLOVING_CHECK_TIME_FACTOR"],
);
const shard = process.env["CLOVING_TEST_SHARD"];
const selected = parseTestShard(shard);
const timings: CheckTiming[] = [];
const commandOptions = { timings };
try {
  if (!selected || selected.index === 1)
    await checkNpmInputs(process.cwd(), commandOptions);
  if (selected)
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
  const generated = await inspectGenerated(process.cwd());
  const result = await checkProject(process.cwd(), {
    timeFactor,
    ...(shard === undefined ? {} : { shard }),
    ...(selected
      ? {
          coverageDirectory:
            process.env["CLOVING_COVERAGE_DIRECTORY"] ?? "coverage/shard",
        }
      : {}),
    commandOptions,
    generated: generated.outputs,
    architecture: proposedModulePolicy(process.cwd()),
    stepExports:
      !selected || selected.index === 1
        ? await productStepExports(process.cwd())
        : {},
  });
  writeProjectReport(result);
} catch (error) {
  console.error(error);
  writeProjectReport({ timings, warnings: checkTimeWarnings(timings) });
  process.exitCode = 1;
}
