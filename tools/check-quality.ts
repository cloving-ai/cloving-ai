import { checkProject } from "../quality/project.ts";
import { inspectGenerated } from "../quality/generated-output.ts";
import { proposedModulePolicy } from "../quality/module-policy.ts";
import { checkNpmInputs } from "../quality/npm-inputs.ts";
import { productStepExports } from "../quality/product-steps.ts";

await checkNpmInputs(process.cwd());
const generated = await inspectGenerated(process.cwd());
const result = await checkProject(process.cwd(), {
  generated: generated.outputs,
  architecture: proposedModulePolicy(process.cwd()),
  stepExports: await productStepExports(process.cwd()),
});
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
