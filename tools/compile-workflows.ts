import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BaseBuilder } from "@workflow/builders";

const [sourceDirectory, outputDirectory] = process.argv.slice(2);
if (!sourceDirectory || !outputDirectory) {
  throw new Error("Usage: npm run build:workflows -- SOURCE_DIRECTORY OUTPUT_DIRECTORY");
}

const output = resolve(outputDirectory);

class WorkflowBuilder extends BaseBuilder {
  override async build(): Promise<void> {
    const inputFiles = await this.getInputFiles();
    await mkdir(output, { recursive: true });
    const result = await this.createCombinedBundle({
      inputFiles,
      stepsOutfile: resolve(output, "steps.mjs"),
      flowOutfile: resolve(output, "flow.mjs"),
      format: "esm",
    });
    await writeFile(resolve(output, "manifest.json"), JSON.stringify(result.manifest, null, 2));
    await this.createClientLibrary();
  }
}

await new WorkflowBuilder({
  buildTarget: "standalone",
  workingDir: process.cwd(),
  dirs: [resolve(sourceDirectory)],
  stepsBundlePath: resolve(output, "steps.mjs"),
  workflowsBundlePath: resolve(output, "flow.mjs"),
  webhookBundlePath: resolve(output, "webhook.mjs"),
  clientBundlePath: resolve(output, "client.mjs"),
  sourcemap: false,
}).build();
