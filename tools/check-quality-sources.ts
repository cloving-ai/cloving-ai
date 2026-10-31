import {
  assertCheckCoverage,
  checkProjectSources,
} from "../quality/project.ts";
import { inspectGenerated } from "../quality/generated-output.ts";
import { proposedModulePolicy } from "../quality/module-policy.ts";
import { productStepExports } from "../quality/product-steps.ts";
import { productionInventory } from "../quality/production-inventory.ts";
import { parseCheckTimeFactor, type CheckTiming } from "../quality/command.ts";

const directory = process.cwd();
const generated = await inspectGenerated(directory);
const timings: CheckTiming[] = [];
const options = {
  timeFactor: parseCheckTimeFactor(process.env["CLOVING_CHECK_TIME_FACTOR"]),
  commandOptions: { timings },
  generated: generated.outputs,
  architecture: proposedModulePolicy(directory),
  stepExports: await productStepExports(directory),
};
const { program, files, completed } = await checkProjectSources(
  directory,
  options,
);
productionInventory(program, { files, roles: options.architecture.roles });
assertCheckCoverage([...completed, "tests"]);
process.stdout.write(JSON.stringify(completed) + "\n");
