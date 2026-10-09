import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { checkProjectSources } from "../quality/project.ts";
import { inspectGenerated } from "../quality/generated-output.ts";
import { proposedModulePolicy } from "../quality/module-policy.ts";

const requested = process.argv[2];
if (!requested) throw new Error("missing-candidate-directory");
const directory = await realpath(requested);
const installed = resolve(import.meta.dirname, "..");
if (directory === (await realpath(installed)))
  throw new Error("verifier-candidate-overlap");
for (const name of ["tsconfig.json", "tsconfig.build.json"]) {
  const accepted = await readFile(resolve(installed, name));
  if (!accepted.equals(await readFile(resolve(directory, name))))
    throw new Error(`unadmitted-compiler-configuration: ${name}`);
}
const generated = await inspectGenerated(directory);
const { files, completed } = await checkProjectSources(directory, {
  trustedCompilerConfiguration: resolve(installed, "tsconfig.json"),
  generated: generated.outputs,
  architecture: proposedModulePolicy(directory),
  stepExports: {},
});
process.stdout.write(
  JSON.stringify(
    { kind: "static-analysis", files, completed, generated },
    null,
    2,
  ) + "\n",
);
