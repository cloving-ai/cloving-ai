import { record, type Fields } from "./protocol.ts";
import type { SubmissionContract, SubmissionField } from "./submission.ts";

export interface WorkflowDeclaration {
  readonly workflowId: string;
  readonly effectLimit: number;
  readonly capabilities: readonly ("claude" | "github")[];
  readonly input: SubmissionContract;
}

export interface DeclaredWorkflow extends WorkflowDeclaration {
  readonly functionName: string;
}

function keys(fields: Fields, allowed: readonly string[]): boolean {
  return Object.keys(fields).every((key) => allowed.includes(key));
}

function integer(
  value: unknown,
  bounds: { minimum: number; maximum: number },
): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= bounds.minimum &&
    value <= bounds.maximum
  );
}

function integerBounds(fields: Fields): boolean {
  const { minimum, maximum } = fields;
  if (minimum !== undefined && !Number.isInteger(minimum)) return false;
  if (maximum !== undefined && !Number.isInteger(maximum)) return false;
  return (
    typeof minimum !== "number" ||
    typeof maximum !== "number" ||
    minimum <= maximum
  );
}

function isField(value: unknown): value is SubmissionField {
  const fields = record(value);
  if (
    fields === undefined ||
    !keys(fields, ["type", "optional", "minimum", "maximum"])
  )
    return false;
  if (
    fields["optional"] !== undefined &&
    typeof fields["optional"] !== "boolean"
  )
    return false;
  if (fields["type"] === "integer") return integerBounds(fields);
  return (
    (fields["type"] === "string" || fields["type"] === "boolean") &&
    !Object.hasOwn(fields, "minimum") &&
    !Object.hasOwn(fields, "maximum")
  );
}

function isInput(value: unknown): value is SubmissionContract {
  const input = record(value);
  if (input === undefined || !keys(input, ["maximumBytes", "fields"]))
    return false;
  const fields = record(input["fields"]);
  return (
    integer(input["maximumBytes"], { minimum: 1, maximum: 1_048_576 }) &&
    fields !== undefined &&
    Object.values(fields).every(isField)
  );
}

export function isWorkflowDeclaration(
  value: unknown,
): value is WorkflowDeclaration {
  const declaration = record(value);
  if (
    declaration === undefined ||
    !keys(declaration, ["workflowId", "effectLimit", "capabilities", "input"])
  )
    return false;
  const { workflowId, effectLimit, capabilities, input } = declaration;
  return (
    typeof workflowId === "string" &&
    /^[A-Za-z0-9-]{1,64}$/.test(workflowId) &&
    integer(effectLimit, { minimum: 1, maximum: 100 }) &&
    Array.isArray(capabilities) &&
    capabilities.length > 0 &&
    capabilities.every(
      (capability: unknown) =>
        capability === "claude" || capability === "github",
    ) &&
    isInput(input)
  );
}
