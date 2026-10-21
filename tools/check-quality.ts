import { checkProject, writeProjectReport } from "../quality/project.ts";
import { inspectGenerated } from "../quality/generated-output.ts";
import { proposedModulePolicy } from "../quality/module-policy.ts";
import { checkNpmInputs } from "../quality/npm-inputs.ts";
import { productStepExports } from "../quality/product-steps.ts";
import { parseCheckTimeFactor } from "../quality/test-execution.ts";
import type { CheckTiming } from "../quality/command.ts";

const timeFactor = parseCheckTimeFactor(
  process.env["CLOVING_CHECK_TIME_FACTOR"],
);
const timings: CheckTiming[] = [];
const commandOptions = { timings };
await checkNpmInputs(process.cwd(), commandOptions);
const generated = await inspectGenerated(process.cwd());
const result = await checkProject(process.cwd(), {
  timeFactor,
  commandOptions,
  generated: generated.outputs,
  architecture: proposedModulePolicy(process.cwd()),
  stepExports: await productStepExports(process.cwd()),
});
writeProjectReport(result);
