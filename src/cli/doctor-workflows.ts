import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DoctorObservation, DoctorWorkflow } from "../doctor-report.ts";
import {
  configurationRoot,
  absoluteWorkflowFolder,
} from "../project-settings.ts";
import { isCandidateDeclaration } from "../workflow-candidate.ts";
import { bundledWorkflowIds } from "../workflow-discovery.ts";

export const bundledDoctorWorkflows = Object.values(bundledWorkflowIds).map(
  (workflowId): DoctorWorkflow => ({
    scope: "bundled",
    workflowId,
    capabilities: ["claude", "github"],
  }),
);

export function workflowObservation(context: {
  readonly workflows: readonly DoctorWorkflow[];
  readonly prerequisite: string | undefined;
}): DoctorObservation {
  if (context.prerequisite !== undefined)
    return { result: "skip", detail: context.prerequisite };
  const found = context.workflows.some(
    (workflow) => workflow.scope === "project" || workflow.scope === "user",
  );
  return {
    result: found ? "ok" : "fail",
    detail: found
      ? "Project or user workflow found"
      : "No project or user workflow",
  };
}

export async function doctorWorkflows(
  repository: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<readonly DoctorWorkflow[]> {
  const discovered: DoctorWorkflow[] = [];
  for (const [scope, folder] of [
    ["project", join(repository, ".cloving/workflows")],
    [
      "user",
      absoluteWorkflowFolder(environment["CLOVING_WORKFLOW_FOLDER"]) ??
        join(configurationRoot(environment, homedir()), "cloving/workflows"),
    ],
  ] as const) {
    const files = await readdir(folder).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    });
    for (const file of files.filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".d.ts") &&
        !file.endsWith(".test.ts"),
    )) {
      const text = await readFile(
        join(folder, file.slice(0, -3) + ".declaration.json"),
        "utf8",
      ).catch(() => undefined);
      if (text === undefined) continue;
      let declaration: unknown;
      try {
        declaration = JSON.parse(text);
      } catch {
        continue;
      }
      if (isCandidateDeclaration(declaration))
        discovered.push({ scope, ...declaration.workflow });
    }
  }
  return [...bundledDoctorWorkflows, ...discovered];
}
