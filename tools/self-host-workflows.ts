import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { WorkflowManifest } from "@workflow/builders";
import {
  isWorkflowDeclaration,
  type DeclaredWorkflow,
} from "../src/workflow-declaration.ts";

interface HostManifest {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly workflowId: string;
  readonly steps: readonly string[];
  readonly capabilities: readonly string[];
  readonly resources: readonly string[];
  readonly artifacts: string;
}

export async function workflowFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();
}

export async function workflowDeclarations(
  directory: string,
  manifests: Readonly<Record<string, HostManifest>>,
): Promise<readonly DeclaredWorkflow[]> {
  const declarations: DeclaredWorkflow[] = [];
  for (const file of await workflowFiles(directory)) {
    const name = basename(file, ".ts");
    const declarationFile = `${name}.declaration.json`;
    const text = await readFile(join(directory, declarationFile), "utf8").catch(
      (error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return undefined;
        throw new Error(`invalid-workflow-declaration: ${declarationFile}`, {
          cause: error,
        });
      },
    );
    if (text === undefined) continue;
    const entry = Object.entries(manifests).find(
      ([, manifest]) => manifest.name === name,
    );
    try {
      const value: unknown = JSON.parse(text);
      if (!isWorkflowDeclaration(value) || entry === undefined)
        throw new Error("Invalid declaration or missing workflow function.");
      declarations.push({
        ...value,
        functionName: entry[0],
        capabilities: [...new Set(value.capabilities)],
      });
    } catch (error) {
      throw new Error(`invalid-workflow-declaration: ${declarationFile}`, {
        cause: error,
      });
    }
  }
  return declarations;
}

export function workflowManifests(
  compiled: WorkflowManifest,
): Readonly<Record<string, HostManifest>> {
  const names = new Set<string>();
  const steps = Object.values(compiled.steps ?? {})
    .flatMap((entries) => Object.values(entries))
    .map((entry) => entry.stepId)
    .filter((identifier) => identifier.startsWith("step//cloving/"));
  return Object.fromEntries(
    Object.entries(compiled.workflows ?? {}).flatMap(([file, entries]) => {
      const functions = Object.values(entries);
      if (functions.length > 1)
        throw new Error(`${file} must contain only one workflow function.`);
      return functions.map((entry) => {
        const workflowId = entry.workflowId;
        const functionName = workflowId.slice(workflowId.lastIndexOf("//") + 2);
        if (names.has(functionName))
          throw new Error(`duplicate-workflow-function: ${functionName}`);
        names.add(functionName);
        return [
          functionName,
          {
            schemaVersion: 1 as const,
            name: basename(file, ".ts"),
            workflowId,
            steps,
            capabilities: ["claude", "github"],
            resources: [],
            artifacts: "artifacts",
          },
        ];
      });
    }),
  );
}
