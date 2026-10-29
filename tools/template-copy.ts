import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import ts from "typescript";
import { record } from "../src/protocol.ts";
import { readTemplate, templateName, type Template } from "./template-files.ts";

interface PlannedFile {
  readonly target: string;
  readonly content: string;
}

interface Renaming {
  readonly template: string;
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

export async function copyTemplate(input: {
  readonly root: string;
  readonly name: string;
  readonly id: string;
  readonly folder: string;
}): Promise<{
  readonly template: Template;
  readonly files: readonly string[];
}> {
  if (!templateName.test(input.id) || input.id.length > 64)
    throw new Error(`invalid-workflow-id: ${input.id}`);
  const template = await readTemplate(input.root, input.name);
  const sources = await Promise.all(
    template.files.map(async (file) => ({
      file,
      text: await readFile(join(input.root, input.name, file), "utf8"),
    })),
  );
  const renaming = functionRenaming(sources, input);
  const plan = sources.map(({ file, text }) => ({
    target: input.id + file.slice(input.name.length),
    content: copiedContent({ file, text }, renaming),
  }));
  await writePlan(input.folder, plan);
  return { template, files: plan.map((item) => item.target) };
}

function camelName(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

function functionRenaming(
  sources: readonly { readonly file: string; readonly text: string }[],
  input: { readonly name: string; readonly id: string },
): Renaming {
  const from = camelName(input.name);
  const names = new Set(
    sources
      .filter(({ file }) => file.endsWith(".ts"))
      .flatMap(({ text }) => text.match(/[A-Za-z_$][\w$]*/g) ?? []),
  );
  let to = camelName(input.id);
  while (to !== from && names.has(to)) to += "Workflow";
  return { template: input.name, id: input.id, from, to };
}

function copiedContent(
  source: { readonly file: string; readonly text: string },
  renaming: Renaming,
) {
  const { file, text } = source;
  if (file.endsWith(".declaration.json"))
    return copiedDeclaration(text, renaming);
  if (!file.endsWith(".ts") || renaming.id === renaming.template) return text;
  return renamedSource(source, renaming);
}

function copiedDeclaration(text: string, renaming: Renaming): string {
  const declaration = record(JSON.parse(text));
  const workflow = record(declaration?.["workflow"]);
  if (declaration === undefined || workflow === undefined)
    throw new Error(`invalid-template: ${renaming.template}`);
  return (
    JSON.stringify(
      {
        template: renaming.template,
        ...declaration,
        workflow: { ...workflow, workflowId: renaming.id },
      },
      null,
      2,
    ) + "\n"
  );
}

function renamedSource(
  input: { readonly file: string; readonly text: string },
  renaming: Renaming,
) {
  const { file, text } = input;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edits: { start: number; end: number; text: string }[] = [];
  const prefix = new RegExp(`^(\\.\\.?/)${renaming.template}(?=[./])`);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === renaming.from)
      edits.push({ start: node.getStart(), end: node.end, text: renaming.to });
    if (
      ts.isStringLiteral(node) &&
      (ts.isImportDeclaration(node.parent) ||
        ts.isExportDeclaration(node.parent)) &&
      prefix.test(node.text)
    )
      edits.push({
        start: node.getStart() + 1,
        end: node.end - 1,
        text: node.text.replace(prefix, `$1${renaming.id}`),
      });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edits
    .sort((left, right) => right.start - left.start)
    .reduce(
      (current, edit) =>
        current.slice(0, edit.start) + edit.text + current.slice(edit.end),
      text,
    );
}

async function writePlan(
  folder: string,
  plan: readonly PlannedFile[],
): Promise<void> {
  await mkdir(folder, { recursive: true });
  const staging = await mkdtemp(join(dirname(folder), ".template-copy-"));
  const created: string[] = [];
  try {
    for (const item of plan) {
      await mkdir(dirname(join(staging, item.target)), { recursive: true });
      await writeFile(join(staging, item.target), item.content);
    }
    for (const item of plan) await placed({ folder, staging, item }, created);
  } catch (error) {
    for (const path of created.reverse())
      await rm(path, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function placed(
  input: {
    readonly folder: string;
    readonly staging: string;
    readonly item: PlannedFile;
  },
  created: string[],
): Promise<void> {
  const parts = input.item.target.split("/");
  for (let depth = 1; depth < parts.length; depth += 1) {
    const directory = join(input.folder, ...parts.slice(0, depth));
    if (created.includes(directory)) continue;
    await mkdir(directory).catch(() => {
      throw new Error(`workflow-exists: ${parts.slice(0, depth).join("/")}`);
    });
    created.push(directory);
  }
  const target = join(input.folder, input.item.target);
  await link(join(input.staging, input.item.target), target).catch(() => {
    throw new Error(`workflow-exists: ${input.item.target}`);
  });
  created.push(target);
}
