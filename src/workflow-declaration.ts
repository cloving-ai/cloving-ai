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
  readonly capabilities: readonly ("claude" | "github" | "chats" | "command")[];
  readonly input: SubmissionContract;
  readonly stages?: readonly WorkflowStage[];
  readonly handoffs?: readonly string[];
  readonly commands?: readonly string[];
}

export interface DeclaredWorkflow extends WorkflowDeclaration {
  readonly functionName: string;
}

function keys(
  fields: Fields | undefined,
  allowed: readonly string[],
): fields is Fields {
  return (
    fields !== undefined &&
    Object.keys(fields).every((key) => allowed.includes(key))
  );
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
  if (!keys(fields, ["type", "optional", "minimum", "maximum"])) return false;
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
  if (!keys(input, ["maximumBytes", "fields"])) return false;
  const fields = record(input["fields"]);
  return (
    integer(input["maximumBytes"], { minimum: 1, maximum: 1_048_576 }) &&
    fields !== undefined &&
    Object.values(fields).every(isField)
  );
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function selectors(
  value: unknown,
  pattern: RegExp,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    Array.from<unknown>(value).every((item) => matches(item, pattern))
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
  if (!keys(stage, ["name", "label", "operations", "gateKinds"])) return false;
  const { name, label } = stage;
  const operations = Object.hasOwn(stage, "operations")
    ? stage["operations"]
    : [];
  const gateKinds = Object.hasOwn(stage, "gateKinds") ? stage["gateKinds"] : [];
  return (
    matches(name, /^[A-Za-z0-9-]{1,64}$/) &&
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

function isCapabilities(
  value: unknown,
): value is WorkflowDeclaration["capabilities"] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (capability: unknown) =>
        capability === "claude" ||
        capability === "github" ||
        capability === "chats" ||
        capability === "command",
    )
  );
}

export function isWorkflowNames(value: unknown): value is readonly string[] {
  return selectors(value, /^[A-Za-z0-9-]{1,64}$/) && unique(value);
}

function declaredCommands(
  declaration: Fields,
  capabilities: readonly string[],
): boolean {
  const commands = declaration["commands"];
  if (Object.hasOwn(declaration, "commands") && !isWorkflowNames(commands))
    return false;
  return (
    !capabilities.includes("command") ||
    (Array.isArray(commands) && commands.length > 0)
  );
}

export function isWorkflowDeclaration(
  value: unknown,
): value is WorkflowDeclaration {
  const declaration = record(value);
  if (
    !keys(declaration, [
      "workflowId",
      "effectLimit",
      "capabilities",
      "input",
      "stages",
      "handoffs",
      "commands",
    ])
  )
    return false;
  const { workflowId, effectLimit, capabilities, input, handoffs } =
    declaration;
  return (
    matches(workflowId, /^[A-Za-z0-9-]{1,64}$/) &&
    integer(effectLimit, { minimum: 1, maximum: 100 }) &&
    isCapabilities(capabilities) &&
    declaredCommands(declaration, capabilities) &&
    isInput(input) &&
    (!Object.hasOwn(declaration, "stages") ||
      isWorkflowStages(declaration["stages"])) &&
    (!Object.hasOwn(declaration, "handoffs") || isWorkflowNames(handoffs))
  );
}
