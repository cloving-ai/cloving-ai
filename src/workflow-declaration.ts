import { record, type Fields } from "./protocol.ts";
import type { SubmissionContract, SubmissionField } from "./submission.ts";

export interface WorkflowStage {
  readonly name: string;
  readonly label: string;
  readonly operations?: readonly string[];
  readonly gateKinds?: readonly ("approval" | "question")[];
}

export type WorkflowStages = Readonly<Record<string, readonly WorkflowStage[]>>;

export interface WorkflowDeclaration {
  readonly workflowId: string;
  readonly effectLimit: number;
  readonly capabilities: readonly ("claude" | "github" | "chats")[];
  readonly input: SubmissionContract;
  readonly stages?: readonly WorkflowStage[];
  readonly handoffs?: readonly string[];
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

function selectors(
  value: unknown,
  pattern: RegExp,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    Array.from<unknown>(value).every(
      (item: unknown) => typeof item === "string" && pattern.test(item),
    )
  );
}

function isStageLabel(label: unknown): boolean {
  return (
    typeof label === "string" &&
    /^[^\p{C}\p{Zl}\p{Zp}]{1,40}$/u.test(label) &&
    label.trim() === label &&
    !["Other", "Done", "Stopped"].includes(label)
  );
}

function isStage(value: unknown): value is WorkflowStage {
  const stage = record(value);
  if (
    stage === undefined ||
    !keys(stage, ["name", "label", "operations", "gateKinds"])
  )
    return false;
  const { name, label } = stage;
  const operations = Object.hasOwn(stage, "operations")
    ? stage["operations"]
    : [];
  const gateKinds = Object.hasOwn(stage, "gateKinds") ? stage["gateKinds"] : [];
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9-]{1,64}$/.test(name) &&
    isStageLabel(label) &&
    selectors(operations, /^[A-Za-z0-9._:/-]{1,128}$/) &&
    selectors(gateKinds, /^(approval|question)$/) &&
    operations.length + gateKinds.length > 0
  );
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function isWorkflowStages(
  value: unknown,
): value is readonly WorkflowStage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12)
    return false;
  const stages: readonly unknown[] = Array.from<unknown>(value);
  if (!stages.every(isStage)) return false;
  return (
    unique(stages.map((stage) => stage.name)) &&
    unique(stages.map((stage) => stage.label)) &&
    unique(stages.flatMap((stage) => stage.operations ?? [])) &&
    unique(stages.flatMap((stage) => stage.gateKinds ?? []))
  );
}

function isCapabilities(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (capability: unknown) =>
        capability === "claude" ||
        capability === "github" ||
        capability === "chats",
    )
  );
}

function optionalDeclarations(declaration: Fields): boolean {
  const handoffs = declaration["handoffs"];
  return (
    (!Object.hasOwn(declaration, "stages") ||
      isWorkflowStages(declaration["stages"])) &&
    (!Object.hasOwn(declaration, "handoffs") ||
      (selectors(handoffs, /^[A-Za-z0-9-]{1,64}$/) && unique(handoffs)))
  );
}

export function isWorkflowDeclaration(
  value: unknown,
): value is WorkflowDeclaration {
  const declaration = record(value);
  if (
    declaration === undefined ||
    !keys(declaration, [
      "workflowId",
      "effectLimit",
      "capabilities",
      "input",
      "stages",
      "handoffs",
    ])
  )
    return false;
  const { workflowId, effectLimit, capabilities, input } = declaration;
  return (
    typeof workflowId === "string" &&
    /^[A-Za-z0-9-]{1,64}$/.test(workflowId) &&
    integer(effectLimit, { minimum: 1, maximum: 100 }) &&
    isCapabilities(capabilities) &&
    isInput(input) &&
    optionalDeclarations(declaration)
  );
}
