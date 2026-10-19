import { record, type ServiceRequest } from "../protocol.ts";

export interface CardField {
  readonly name: string;
  readonly label: string;
  readonly multiline: boolean;
  readonly optional: boolean;
}

export interface CardForm {
  readonly workflowId: string;
  readonly source: "ticket" | "prompt" | "input";
  readonly fields: readonly CardField[];
}

export function builtinCardForms(): readonly CardForm[] {
  const entries: readonly [string, "ticket" | "prompt", string][] = [
    ["develop-issue", "ticket", "Issue number"],
    ["develop-ticket", "ticket", "Ticket ID"],
    ["develop-prd", "prompt", "Idea"],
    ["develop-prompt", "prompt", "Task"],
  ];
  return entries.map(([workflowId, name, label]) => ({
    workflowId,
    source: name === "ticket" ? "ticket" : "prompt",
    fields: [{ name, label, multiline: name === "prompt", optional: false }],
  }));
}

function validFields(
  form: CardForm,
  fields: Readonly<Record<string, unknown>>,
): boolean {
  if (
    Object.keys(fields).some(
      (name) => !form.fields.some((field) => field.name === name),
    )
  )
    return false;
  return form.fields.every((field) => {
    if (field.optional && !Object.hasOwn(fields, field.name)) return true;
    const text = fields[field.name];
    return typeof text === "string" && text.trim() !== "";
  });
}

export function cardRunRequest(
  forms: readonly CardForm[],
  value: unknown,
): ServiceRequest | null {
  const body = record(value);
  if (
    body === undefined ||
    Object.keys(body).some(
      (key) => !["workflowId", "fields", "commandId"].includes(key),
    )
  )
    return null;
  const { workflowId, commandId } = body;
  const form = forms.find((item) => item.workflowId === workflowId);
  const fields = record(body["fields"]);
  if (
    form === undefined ||
    fields === undefined ||
    typeof commandId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(commandId)
  )
    return null;
  if (!validFields(form, fields)) return null;
  return {
    operation: "run",
    parameters: {
      workflowId,
      source: form.source,
      submission: fields,
      commandId,
    },
  };
}
