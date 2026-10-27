import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isWorkflowDeclaration } from "../workflow-declaration.ts";
import { builtinCardForms, type CardForm } from "./watch-run-input.ts";

export async function watchCardForms(
  directory: string,
): Promise<readonly CardForm[]> {
  const forms = [...builtinCardForms()];
  const files = await readdir(directory).catch(() => []);
  for (const file of files
    .filter((name) => name.endsWith(".declaration.json"))
    .sort()) {
    const value: unknown = await readFile(join(directory, file), "utf8")
      .then((text): unknown => JSON.parse(text))
      .catch(() => null);
    if (!isWorkflowDeclaration(value)) continue;
    const entries = Object.entries(value.input.fields);
    if (
      !entries.every(
        ([, rule]) =>
          rule === "string" || rule.type === "string" || rule.type === "ticket",
      )
    )
      continue;
    if (forms.some((form) => form.workflowId === value.workflowId)) continue;
    forms.push({
      workflowId: value.workflowId,
      source: "input",
      fields: entries.map(([name, rule]) => ({
        name,
        label: rule !== "string" && rule.type === "ticket" ? "Ticket ID" : name,
        multiline: false,
        optional: rule !== "string" && rule.optional === true,
      })),
    });
  }
  return forms;
}
