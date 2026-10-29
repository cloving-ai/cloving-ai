import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { record, type Fields } from "../src/protocol.ts";

export interface TemplateSummary {
  readonly name: string;
  readonly summary: string;
  readonly points: number;
}

export interface Template {
  readonly name: string;
  readonly description: Fields;
  readonly points: readonly unknown[];
  readonly files: readonly string[];
}

export const templateName = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const descriptionFiles = ["template.json", "README.md"];

export function templateRoot(start: string = import.meta.dirname): string {
  let directory = start;
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error("templates-not-found");
    directory = parent;
  }
  return join(directory, "templates");
}

export async function templateList(
  root: string,
): Promise<readonly TemplateSummary[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory() && templateName.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const templates = await Promise.all(
    names.map((name) => readTemplate(root, name).catch(() => undefined)),
  );
  return templates.flatMap((template) =>
    template === undefined
      ? []
      : [
          {
            name: template.name,
            summary: String(template.description["summary"]),
            points: template.points.length,
          },
        ],
  );
}

export async function readTemplate(
  root: string,
  name: string,
): Promise<Template> {
  if (!templateName.test(name)) throw new Error(`unknown-template: ${name}`);
  const folder = join(root, name);
  const text = await readFile(join(folder, "template.json"), "utf8").catch(
    () => {
      throw new Error(`unknown-template: ${name}`);
    },
  );
  const description = record(JSON.parse(text));
  const points = description?.["points"];
  if (
    description === undefined ||
    typeof description["summary"] !== "string" ||
    !Array.isArray(points)
  )
    throw new Error(`invalid-template: ${name}`);
  return { name, description, points, files: await workflowFiles(folder) };
}

async function workflowFiles(folder: string): Promise<readonly string[]> {
  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(folder.length + 1)
        .split("\\")
        .join("/"),
    )
    .filter((file) => !descriptionFiles.includes(file))
    .sort();
}
