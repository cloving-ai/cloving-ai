export interface GeneratedRecord {
  readonly inputs: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, string>>;
  readonly generator: string;
}

function digest(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function configurationInputs(directory: string): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const name of ["tsconfig.json", "tsconfig.build.json"]) {
    const bytes = readFileSync(join(directory, name));
    const value: unknown = JSON.parse(bytes.toString());
    if (!value || typeof value !== "object")
      throw new Error("invalid-build-configuration");
    if (
      "extends" in value &&
      (name !== "tsconfig.build.json" || value.extends !== "./tsconfig.json")
    )
      throw new Error("unsupported-build-configuration");
    inputs[name] = digest(bytes);
  }
  return inputs;
}

export async function inspectGenerated(
  directory: string,
): Promise<GeneratedRecord> {
  const generator = `typescript@${ts.version}:tsc --project tsconfig.build.json`;
  if (!existsSync(join(directory, "dist")))
    return { inputs: {}, outputs: {}, generator };
  const parsed = compilerConfiguration(join(directory, "tsconfig.build.json"));
  if (parsed.fileNames.length === 0 || parsed.projectReferences?.length)
    throw new Error("unsupported-generator-project");
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  if (ts.getPreEmitDiagnostics(program).length > 0)
    throw new Error("generator-compiler-diagnostics");
  const outputs = regeneratedOutputs(program, directory);
  return {
    inputs: await generatorInputs(directory, { program, outputs }),
    outputs,
    generator,
  };
}

async function generatorInputs(
  directory: string,
  generated: {
    readonly program: ts.Program;
    readonly outputs: Readonly<Record<string, string>>;
  },
): Promise<Record<string, string>> {
  const { program, outputs } = generated;
  const inputs = configurationInputs(directory);
  for (const source of program.getSourceFiles()) {
    const name = relative(directory, source.fileName);
    if (!name.startsWith(`..${sep}`) && !name.startsWith(`node_modules${sep}`))
      inputs[name] = digest(readFileSync(source.fileName));
  }
  const inventory = await inspectInventory(directory, outputs);
  for (const name of inventory.metadata) {
    if (name.split(sep).at(-1) === "package.json")
      inputs[name] = digest(await readFile(join(directory, name)));
  }
  return inputs;
}

function regeneratedOutputs(
  program: ts.Program,
  directory: string,
): Record<string, string> {
  const outputs: Record<string, string> = {};
  const result = program.emit(undefined, (file, content) => {
    verifyOutput(directory, { file, content });
    outputs[relative(directory, file)] = digest(content);
  });
  if (
    result.emitSkipped ||
    result.diagnostics.length > 0 ||
    Object.keys(outputs).length === 0
  )
    throw new Error("generator-emission-failed");
  return outputs;
}

function verifyOutput(
  directory: string,
  output: { readonly file: string; readonly content: string },
): void {
  const { file, content } = output;
  if (!resolve(file).startsWith(resolve(directory, "dist") + sep))
    throw new Error(`unadmitted-generator-output: ${file}`);
  if (!existsSync(file)) throw new Error(`missing-generated-output: ${file}`);
  if (!lstatSync(file).isFile())
    throw new Error(`invalid-generated-output: ${file}`);
  if (digest(readFileSync(file)) !== digest(content))
    throw new Error(`generated-output-mismatch: ${file}`);
}
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { compilerConfiguration } from "./compiler.ts";
import { inspectInventory } from "./inventory.ts";
