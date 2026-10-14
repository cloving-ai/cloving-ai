import { readdir } from "node:fs/promises";
import { basename } from "node:path";

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

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

export function workflowManifests(
  compiled: unknown,
): Readonly<Record<string, HostManifest>> {
  const categories = record(compiled);
  const steps = Object.values(record(categories["steps"]))
    .flatMap((entries) => Object.values(record(entries)))
    .map((entry) => String(record(entry)["stepId"]))
    .filter((identifier) => identifier.startsWith("step//cloving/"));
  return Object.fromEntries(
    Object.entries(record(categories["workflows"])).flatMap(
      ([file, entries]) => {
        const functions = Object.values(record(entries));
        if (functions.length > 1)
          throw new Error(`${file} must contain only one workflow function.`);
        return functions.map((entry) => {
          const workflowId = String(record(entry)["workflowId"]);
          const functionName = workflowId.slice(
            workflowId.lastIndexOf("//") + 2,
          );
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
      },
    ),
  );
}
