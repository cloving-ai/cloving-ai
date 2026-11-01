import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isWorkflowDeclaration } from "../workflow-declaration.ts";
import { record } from "../protocol.ts";
import type { CardForm } from "./watch-run-input.ts";

export async function watchCardForms(
  directory: string,
): Promise<readonly CardForm[]> {
  const forms: CardForm[] = [];
  const declarations: unknown = await readFile(
    join(directory, "declarations.json"),
    "utf8",
  )
    .then((text): unknown => JSON.parse(text))
    .catch(() => null);
  if (!Array.isArray(declarations)) return [];
  for (const declaration of declarations) {
    const value = { ...record(declaration) };
    delete value["functionName"];
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
