import { realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { parseArgs } from "node:util";
import packageMetadata from "#package" with { type: "json" };
import { absoluteWorkflowFolder } from "../src/project-settings.ts";
import { record } from "../src/protocol.ts";
import { isCandidateDeclaration } from "../src/workflow-candidate.ts";
import { declaresQueue } from "../src/workflow-declaration.ts";
import { projectConfiguration, projectRoot } from "./project-configuration.ts";
import { applyLocalPreset } from "./local-preset.ts";
import { copyTemplate, type ScriptSetting } from "./template-copy.ts";
import {
  exportedFunctions,
  readTemplate,
  templateList,
  templateRoot,
} from "./template-files.ts";
import { userLocation } from "./workflow-folders.ts";

const usage =
  "Usage: cloving templates list [--json]\n       cloving templates show <name> [--json]\n       cloving templates copy <name> [--id <workflow-id>] [--json] [--repository <directory>]\n       cloving templates apply-local [--repository <directory>]\n";

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
  if (command === "apply-local")
    return localInvocation({ values, name, extra });
  return namedInvocation({ values, command, name, extra });
}

function localInvocation(input: {
  readonly values: {
    readonly id?: string;
    readonly json?: boolean;
    readonly repository?: string;
    readonly help?: boolean;
  };
  readonly name: string | undefined;
  readonly extra: readonly string[];
}) {
  if (input.name !== undefined || input.extra.length > 0)
    throw new Error("unexpected-argument");
  if (input.values.id !== undefined) throw new Error("unexpected-option");
  return { ...input.values, command: "apply-local", name: "" };
}

function namedInvocation(input: {
  readonly values: {
    readonly id?: string;
    readonly json?: boolean;
    readonly repository?: string;
    readonly help?: boolean;
  };
  readonly command: string | undefined;
  readonly name: string | undefined;
  readonly extra: readonly string[];
}) {
  const { values, command, name, extra } = input;
  if (command === undefined || !["list", "show", "copy"].includes(command))
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
    return await runSelected(templateRoot(), selected);
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.message : "template-command-failed") +
        "\n",
    );
    return 1;
  }
}

async function runSelected(
  root: string,
  selected: {
    readonly command: string;
    readonly name: string;
    readonly json?: boolean | undefined;
    readonly id?: string | undefined;
    readonly repository?: string | undefined;
  },
): Promise<number> {
  const json = selected.json === true;
  const repository = selected.repository ?? process.cwd();
  if (selected.command === "list") return await listed(root, { json });
  if (selected.command === "show")
    return await shown(root, { name: selected.name, json });
  if (selected.command === "apply-local")
    return await applied(root, { repository });
  return await copied(root, {
    name: selected.name,
    id: selected.id ?? selected.name,
    json,
    repository,
  });
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

async function applied(
  root: string,
  input: { readonly repository: string },
): Promise<number> {
  const repository = await projectRoot(input.repository);
  const folder = join(repository, ".cloving", "workflows");
  const folders = [folder, await userFolder(repository)];
  const packageRoot = dirname(root);
  const takenNames = await exportedFunctions([
    join(packageRoot, "workflows"),
    join(packageRoot, "dist", "workflows"),
    ...folders,
  ]);
  await copyTemplate({
    root,
    name: "develop",
    id: "develop",
    folder,
    takenNames,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  await applyLocalPreset({ folder, id: "develop" });
  process.stdout.write(
    localPresetText({
      prefix: localCommandPrefix({
        packagePath: realpathSync(import.meta.dirname),
        version: packageMetadata.version,
        runtimeDirectory: process.env["CLOVING_RUNTIME_DIR"],
      }),
      repository,
    }),
  );
  return 0;
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

export function localCommandPrefix(input: {
  readonly packagePath: string;
  readonly version: string;
  readonly runtimeDirectory?: string | undefined;
}): string {
  const program = input.packagePath.split(sep).includes("_npx")
    ? `npx cloving@${input.version}`
    : "cloving";
  const runtime = input.runtimeDirectory;
  if (runtime === undefined || runtime.length === 0) return program;
  return `CLOVING_RUNTIME_DIR=${shellArgument(runtime)} ${program}`;
}

export function localCommand(input: {
  readonly prefix: string;
  readonly command: string;
  readonly repository: string;
}): string {
  return `${input.prefix} ${input.command} --repository ${shellArgument(input.repository)}`;
}

function localPresetText(input: {
  readonly prefix: string;
  readonly repository: string;
}): string {
  const command = (text: string) =>
    localCommand({
      prefix: input.prefix,
      command: text,
      repository: input.repository,
    });
  return [
    "Copied develop for one local task.",
    "Choices: input task-text, select person, verify none, accept person, merge local, partial person, recovery stop, lessons none, demo none.",
    "The run does not push, open a pull request, or merge.",
    "",
    "Next:",
    `  ${command("start")}`,
    `  ${command('run develop --prompt "Add a test for the date parser"')}`,
    `  ${command("questions")}`,
    "",
    "Open http://127.0.0.1:3663/ to watch the run.",
    `After the run completes, run \`${command("init --factory")}\` to add review, a plan, and regular maintenance.`,
    "",
  ].join("\n");
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
  const folders = [folder, await userFolder(repository)];
  const packageRoot = dirname(root);
  const takenNames = await exportedFunctions([
    join(packageRoot, "workflows"),
    join(packageRoot, "dist", "workflows"),
    ...folders,
  ]);
  const result = await copyTemplate({
    ...input,
    root,
    folder,
    takenNames,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const queued = (await Promise.all(folders.map(queuedIn))).flat().sort();
  if (input.json)
    process.stdout.write(
      JSON.stringify({
        workflowId: input.id,
        template: input.name,
        files: result.files,
        queueWorkflows: queued,
        settings: result.settings,
      }) + "\n",
    );
  else
    process.stdout.write(
      `Copied the template ${input.name} to .cloving/workflows as the workflow ${input.id}.\nDecision points:\n${pointText(result.template.points)}${settingText(result.settings)}Next: cloving workflows test ${input.id}\n`,
    );
  return 0;
}

function settingText(settings: readonly ScriptSetting[]): string {
  if (settings.length === 0) return "";
  const lines = settings.map(
    ({ setting, command }) =>
      `  cloving config set ${setting} '${JSON.stringify(command).replaceAll("'", "'\\''")}' --private\n`,
  );
  return `Settings for the copied scripts:\n${lines.join("")}`;
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

async function userFolder(repository: string): Promise<string> {
  const settings = await projectConfiguration(repository, process.env);
  const user = userLocation({
    home: homedir(),
    xdgConfigHome: process.env["XDG_CONFIG_HOME"],
    userFolder: absoluteWorkflowFolder(
      settings.environment["CLOVING_WORKFLOW_FOLDER"],
    ),
  });
  return join(user.root, ...user.parts);
}

async function queuedIn(folder: string): Promise<readonly string[]> {
  const names = await readdir(folder).catch(() => []);
  const ids = await Promise.all(
    names
      .filter((name) => name.endsWith(".declaration.json"))
      .map((name) => queuedId(folder, name)),
  );
  return ids.flatMap((id) => (id === undefined ? [] : [id]));
}

async function queuedId(
  folder: string,
  name: string,
): Promise<string | undefined> {
  const text = await readFile(join(folder, name), "utf8").catch(() => "");
  let declaration: unknown;
  try {
    declaration = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !isCandidateDeclaration(declaration) ||
    !declaresQueue(declaration.workflow.queue)
  )
    return undefined;
  const source = join(folder, name.replace(/\.declaration\.json$/, ".ts"));
  const entry = await stat(source).catch(() => undefined);
  return entry?.isFile() === true ? declaration.workflow.workflowId : undefined;
}

if (process.argv[1] === import.meta.filename)
  process.exitCode = await templateCommand(process.argv.slice(2));
