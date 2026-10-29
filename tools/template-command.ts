import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { absoluteWorkflowFolder } from "../src/project-settings.ts";
import { record } from "../src/protocol.ts";
import { projectConfiguration, projectRoot } from "./project-configuration.ts";
import { copyTemplate } from "./template-copy.ts";
import { readTemplate, templateList, templateRoot } from "./template-files.ts";
import { userLocation } from "./workflow-folders.ts";

const usage =
  "Usage: cloving templates list [--json]\n       cloving templates show <name> [--json]\n       cloving templates copy <name> [--id <workflow-id>] [--json] [--repository <directory>]\n";

function invocation(argumentsList: readonly string[]) {
  const { values, positionals } = parseArgs({
    args: [...argumentsList],
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      id: { type: "string" },
      repository: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, name, ...extra] = positionals;
  if (values.help === true) return { ...values, command: "help", name: "" };
  if (!["list", "show", "copy"].includes(command ?? ""))
    throw new Error("unknown-command");
  if (extra.length > 0 || (command === "list") !== (name === undefined))
    throw new Error("unexpected-argument");
  if (command !== "copy" && (values.id !== undefined || values.repository))
    throw new Error("unexpected-option");
  return { ...values, command, name: name ?? "" };
}

export async function templateCommand(
  argumentsList: readonly string[],
): Promise<number> {
  let selected;
  try {
    selected = invocation(argumentsList);
  } catch {
    process.stderr.write("invalid-invocation: " + usage);
    return 2;
  }
  if (selected.help) {
    process.stdout.write(usage);
    return 0;
  }
  try {
    const root = templateRoot();
    const json = selected.json === true;
    if (selected.command === "list") return await listed(root, { json });
    if (selected.command === "show")
      return await shown(root, { name: selected.name, json });
    return await copied(root, {
      name: selected.name,
      id: selected.id ?? selected.name,
      json,
      repository: selected.repository ?? process.cwd(),
    });
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.message : "template-command-failed") +
        "\n",
    );
    return 1;
  }
}

async function listed(
  root: string,
  input: { readonly json: boolean },
): Promise<number> {
  const templates = await templateList(root);
  if (input.json) process.stdout.write(JSON.stringify(templates) + "\n");
  else
    for (const template of templates)
      process.stdout.write(
        `${template.name}: ${template.summary} (${String(template.points)} decision points)\n`,
      );
  return 0;
}

async function shown(
  root: string,
  input: { readonly name: string; readonly json: boolean },
): Promise<number> {
  const template = await readTemplate(root, input.name);
  if (input.json) {
    process.stdout.write(
      JSON.stringify({
        template: template.description,
        files: template.files,
      }) + "\n",
    );
    return 0;
  }
  process.stdout.write(
    `${template.name}: ${String(template.description["summary"])}\n${pointText(template.points)}Files:\n${template.files.map((file) => `  ${file}\n`).join("")}`,
  );
  return 0;
}

async function copied(
  root: string,
  input: {
    readonly name: string;
    readonly id: string;
    readonly json: boolean;
    readonly repository: string;
  },
): Promise<number> {
  const repository = await projectRoot(input.repository);
  const folder = join(repository, ".cloving", "workflows");
  const result = await copyTemplate({
    root,
    name: input.name,
    id: input.id,
    folder,
  });
  const queued = await queueWorkflows(repository, folder);
  if (input.json)
    process.stdout.write(
      JSON.stringify({
        workflowId: input.id,
        template: input.name,
        files: result.files,
        queueWorkflows: queued,
      }) + "\n",
    );
  else
    process.stdout.write(
      `Copied the template ${input.name} to .cloving/workflows as the workflow ${input.id}.\nDecision points:\n${pointText(result.template.points)}Next: cloving workflows test ${input.id}\n`,
    );
  if (queued.length > 1)
    process.stderr.write(
      `queue-workflow-conflict: ${queued.join(", ")} have "queue": true. Select "a person" for the select point of one copy: remove workflow.queue from its declaration.\n`,
    );
  return 0;
}

function pointText(points: readonly unknown[]): string {
  return points
    .map((value) => {
      const point = record(value);
      const options = point?.["options"];
      const lines = (Array.isArray(options) ? options : []).map(
        (option: unknown, index) => {
          const fields = record(option);
          return `    - ${String(fields?.["id"])}: ${String(fields?.["label"])}${index === 0 ? " (default)" : ""}\n`;
        },
      );
      return `  ${String(point?.["id"])}: ${String(point?.["question"])}\n${lines.join("")}`;
    })
    .join("");
}

async function queueWorkflows(
  repository: string,
  folder: string,
): Promise<readonly string[]> {
  const settings = await projectConfiguration(repository, process.env);
  const user = userLocation({
    home: homedir(),
    xdgConfigHome: process.env["XDG_CONFIG_HOME"],
    userFolder: absoluteWorkflowFolder(
      settings.environment["CLOVING_WORKFLOW_FOLDER"],
    ),
  });
  const folders = [folder, join(user.root, ...user.parts)];
  const ids = await Promise.all(folders.map(queuedIn));
  return ids.flat().sort();
}

async function queuedIn(folder: string): Promise<readonly string[]> {
  const names = await readdir(folder).catch(() => []);
  const declarations = await Promise.all(
    names
      .filter((name) => name.endsWith(".declaration.json"))
      .map((name) => readFile(join(folder, name), "utf8").catch(() => "")),
  );
  return declarations.flatMap((text) => {
    let workflow;
    try {
      workflow = record(record(JSON.parse(text))?.["workflow"]);
    } catch {
      return [];
    }
    return workflow?.["queue"] === true ? [String(workflow["workflowId"])] : [];
  });
}

if (process.argv[1] === import.meta.filename)
  process.exitCode = await templateCommand(process.argv.slice(2));
