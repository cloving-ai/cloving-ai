import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
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
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.(?:ts|js)$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts") &&
        !entry.name.endsWith(".test.ts"),
    )
    .map((entry) => entry.name)
    .sort();
}

export async function workflowDeclarations(
  directory: string,
  manifests: Readonly<Record<string, HostManifest>>,
): Promise<readonly DeclaredWorkflow[]> {
  const declarations: DeclaredWorkflow[] = [];
  for (const file of await workflowFiles(directory)) {
    const name = basename(file, extname(file));
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
  declarations: readonly DeclaredWorkflow[] = [],
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
            name: basename(file, extname(file)),
            workflowId,
            steps,
            capabilities: declarations.find(
              (declaration) => declaration.functionName === functionName,
            )?.capabilities ?? ["claude", "github"],
            resources: [],
            artifacts: "artifacts",
          },
        ];
      });
    }),
  );
}

export function workflowBundleLoader(): string {
  return `
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
const bundleRegistries = new AsyncLocalStorage();
const registryKeys = ["@workflow/core//registeredSteps", "workflow-class-registry"].map(Symbol.for);
for (const key of registryKeys) {
  let current = globalThis[key] ?? new Map();
  Object.defineProperty(globalThis, key, {
    configurable: true,
    get: () => bundleRegistries.getStore()?.get(key) ?? current,
    set: (value) => {
      const scope = bundleRegistries.getStore();
      if (scope === undefined) current = value;
      else scope.set(key, value);
    },
  });
}
const loadedBundles = new Map();
const loadWorkflowBundle = (directory) => {
  const known = loadedBundles.get(directory);
  if (known !== undefined) return known;
  const scope = new Map(registryKeys.map((key) => [key, new Map()]));
  const loaded = bundleRegistries.run(scope, async () => {
    const workflows = await import(pathToFileURL(directory + "/artifacts/client.mjs").href);
    const { POST } = await import(pathToFileURL(directory + "/artifacts/flow.mjs").href);
    if (typeof POST !== "function") throw new Error("pinned-workflow-unavailable");
    return { workflows, handler: (request) => bundleRegistries.run(scope, () => POST(request)) };
  });
  loadedBundles.set(directory, loaded);
  return loaded;
};
`;
}
