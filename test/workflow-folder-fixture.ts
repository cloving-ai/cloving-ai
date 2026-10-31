import { join } from "node:path";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  isCandidateDeclaration,
  type CandidateDeclaration,
} from "../src/workflow-candidate.ts";
import type { WorkflowFolderInput } from "../tools/workflow-folders.ts";
import {
  candidateDeclaration,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";

export async function writeDeclaredWorkflow(
  repository: string,
  template: "develop" | "idea-to-issue" = "develop",
): Promise<CandidateDeclaration> {
  if (template === "idea-to-issue") await writeDeclaredWorkflow(repository);
  await cp(
    join(import.meta.dirname, "../templates", template),
    join(repository, ".cloving/workflows"),
    {
      recursive: true,
      filter: (source) =>
        !source.endsWith("/template.json") && !source.endsWith("/README.md"),
    },
  );
  const declaration: unknown = JSON.parse(
    await readFile(
      join(repository, ".cloving/workflows", `${template}.declaration.json`),
      "utf8",
    ),
  );
  if (!isCandidateDeclaration(declaration))
    throw new Error("invalid-fixture-declaration");
  return declaration;
}

export async function writeLocalWorkflow(
  repository: string,
  options: { readonly input?: "prompt" } = {},
): Promise<void> {
  await writeDeclaredWorkflow(repository);
  const folder = join(repository, ".cloving/workflows");
  const source = await readFile(join(folder, "develop.ts"), "utf8");
  await writeFile(
    join(folder, "develop.ts"),
    source
      .replaceAll(
        "ticketInput",
        options.input === "prompt" ? "promptInput" : "ticketInput",
      )
      .replace(
        'import { preparePull, labelTicket } from "./develop/pull.ts";\n',
        "",
      )
      .replace(
        'import { developRound } from "./develop/round.ts";',
        'import { localRound as developRound } from "./develop/local.ts";',
      )
      .replace("  await preparePull(input.cycleId);\n", "")
      .replace('  await labelTicket(input, { key: "start", round: 1 });\n', "")
      .replace("  let endingRound = 1;\n", "")
      .replace("      endingRound = round;\n", "")
      .replace(
        '  if (outcome.kind === "blocked")\n    await labelTicket(input, { key: "blocked", round: endingRound });\n',
        "",
      ),
  );
  const file = join(folder, "develop.declaration.json");
  const declaration: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isCandidateDeclaration(declaration))
    throw new Error("invalid-fixture-declaration");
  await writeFile(
    file,
    JSON.stringify({
      ...declaration,
      workflow: {
        ...declaration.workflow,
        queue: undefined,
        capabilities: ["claude"],
        input:
          options.input === "prompt"
            ? {
                ...declaration.workflow.input,
                fields: { prompt: { type: "string" } },
              }
            : declaration.workflow.input,
      },
      methods: { claude: declaration.methods["claude"] },
    }),
  );
}

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

export function privateFolderFiles(name: string) {
  return Object.fromEntries(
    Object.entries(operatorFiles("user", name)).map(([path, contents]) => [
      path.replace("config/cloving/workflows", "private/workflows"),
      contents,
    ]),
  );
}

export function folderInput(directory: string): WorkflowFolderInput {
  return {
    repository: join(directory, "repo"),
    home: directory,
    xdgConfigHome: join(directory, "config"),
    bundled: [],
  };
}

export async function writeQueueWorkflow(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "queued.ts"),
    'export async function queued() {\n  "use workflow";\n  return { kind: "blocked" };\n}\n',
  );
  await writeFile(
    join(folder, "queued.declaration.json"),
    JSON.stringify({
      ...candidateDeclaration,
      workflow: {
        ...candidateDeclaration.workflow,
        workflowId: "queued",
        queue: true,
        input: { maximumBytes: 4096, fields: { ticket: { type: "ticket" } } },
      },
    }),
  );
}
