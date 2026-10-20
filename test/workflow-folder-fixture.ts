import { join } from "node:path";
import type { WorkflowFolderInput } from "../tools/workflow-folders.ts";
import {
  candidateDeclaration,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";

export function operatorFiles(scope: "project" | "user", name: string) {
  const folder =
    scope === "project"
      ? "repo/.cloving/workflows"
      : "config/cloving/workflows";
  return {
    [`${folder}/${name}.ts`]: validCandidateSource.replaceAll(
      "candidate",
      name,
    ),
    [`${folder}/${name}.declaration.json`]: JSON.stringify({
      ...candidateDeclaration,
      workflow: { ...candidateDeclaration.workflow, workflowId: name },
    }),
  };
}

export function folderInput(directory: string): WorkflowFolderInput {
  return {
    repository: join(directory, "repo"),
    home: directory,
    xdgConfigHome: join(directory, "config"),
    bundled: [],
  };
}
