import { record, type Fields } from "./protocol.ts";
import {
  hasTicketField,
  type SubmissionContract,
  type SubmissionField,
} from "./submission.ts";
import {
  checkWorkflowSchedule,
  type WorkflowSchedule,
} from "./workflow-schedule.ts";

export interface WorkflowStage {
  readonly name: string;
  readonly label: string;
  readonly operations?: readonly string[];
  readonly gateKinds?: readonly ("approval" | "question")[];
  readonly gateIds?: readonly string[];
}

export type WorkflowStages = Readonly<Record<string, readonly WorkflowStage[]>>;

export interface CommandWaitDeclaration {
  readonly command: string;
  readonly maximumWaitSeconds: number;
  readonly pollEverySeconds: number;
}

export type CommandWaits = Readonly<Record<string, CommandWaitDeclaration>>;

export interface WorkflowDeclaration {
  readonly workflowId: string;
  readonly effectLimit: number;
  readonly chainLimit?: number;
  readonly spendLimitUsd?: number;
  readonly capabilities: readonly ("claude" | "github" | "command")[];
  readonly input: SubmissionContract;
  readonly stages?: readonly WorkflowStage[];
  readonly handoffs?: readonly string[];
  readonly commands?: readonly string[];
  readonly commandWaits?: CommandWaits;
  readonly queue?: boolean | QueueDeclaration;
  readonly schedule?: WorkflowSchedule;
}

export interface QueueDeclaration {
  readonly everySeconds?: number;
  readonly lanes?: number;
  readonly feed?: string;
  readonly feedEffectLimit?: number;
}

export interface DeclaredWorkflow extends WorkflowDeclaration {
  readonly functionName: string;
}

export function queueFeed(
  declaration: Pick<WorkflowDeclaration, "queue">,
): string | undefined {
  const { queue } = declaration;
  return typeof queue === "object" ? queue.feed : undefined;
}

export function feedMethodReadOnly(effect: {
  readonly capability: string | null;
  readonly method: string | null;
}): boolean {
  if (effect.capability === "command")
    return effect.method?.startsWith("run:") === true;
  return (
    effect.capability === "github" &&
    ["issues", "issue-states", "review-threads"].includes(effect.method ?? "")
  );
}

export type WorkflowQueueCode =
  "queue-needs-ticket-field" | "queue-input-incomplete" | "invalid-queue-shape";

export function isQueueDeclaration(value: unknown): value is QueueDeclaration {
  const queue = record(value);
  if (!keys(queue, ["everySeconds", "lanes", "feed", "feedEffectLimit"]))
    return false;
  return (
    (!Object.hasOwn(queue, "everySeconds") ||
      integer(queue["everySeconds"], { minimum: 10, maximum: 3600 })) &&
    (!Object.hasOwn(queue, "lanes") ||
      integer(queue["lanes"], { minimum: 1, maximum: 16 })) &&
    (!Object.hasOwn(queue, "feed") ||
      matches(queue["feed"], /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/)) &&
    (!Object.hasOwn(queue, "feedEffectLimit") ||
      (typeof queue["feed"] === "string" &&
        integer(queue["feedEffectLimit"], { minimum: 1, maximum: 1000 })))
  );
}

export function declaresQueue(queue: unknown): boolean {
  return queue === true || isQueueDeclaration(queue);
}

export function workflowQueueRefusals(
  value: unknown,
): readonly WorkflowQueueCode[] {
  const declaration = record(value);
  if (declaration === undefined || !Object.hasOwn(declaration, "queue"))
    return [];
  const queue = declaration["queue"];
  if (typeof queue !== "boolean" && !isQueueDeclaration(queue))
    return ["invalid-queue-shape"];
  if (!declaresQueue(queue) || !isInput(declaration["input"])) return [];
  const input = declaration["input"];
  if (!hasTicketField(input)) return ["queue-needs-ticket-field"];
  return Object.entries(input.fields).some(
    ([name, rule]) =>
      name !== "ticket" && (rule === "string" || rule.optional !== true),
  )
    ? ["queue-input-incomplete"]
    : [];
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
    (fields["type"] === "string" ||
      fields["type"] === "boolean" ||
      fields["type"] === "ticket") &&
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
    Object.entries(fields).every(
      ([name, rule]) =>
        isField(rule) && (rule.type !== "ticket" || name === "ticket"),
    )
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
  if (!keys(stage, ["name", "label", "operations", "gateKinds", "gateIds"]))
    return false;
  const { name, label } = stage;
  const operations = Object.hasOwn(stage, "operations")
    ? stage["operations"]
    : [];
  const gateKinds = Object.hasOwn(stage, "gateKinds") ? stage["gateKinds"] : [];
  const gateIds = Object.hasOwn(stage, "gateIds") ? stage["gateIds"] : [];
  return (
    matches(name, /^[A-Za-z0-9-]{1,64}$/) &&
    isStageLabel(label) &&
    selectors(operations, /^[A-Za-z0-9._:/-]{1,128}$/) &&
    selectors(gateKinds, /^(approval|question)$/) &&
    selectors(gateIds, /^[A-Za-z0-9._:/-]{1,128}$/) &&
    operations.length + gateKinds.length + gateIds.length > 0
  );
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function workflowStagesOf(value: unknown): WorkflowStages {
  return Object.fromEntries(
    Object.entries(record(value) ?? {}).flatMap(([workflowId, stages]) =>
      isWorkflowStages(stages) ? [[workflowId, stages]] : [],
    ),
  );
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
    unique(stages.flatMap((stage) => stage.gateKinds ?? [])) &&
    unique(stages.flatMap((stage) => stage.gateIds ?? []))
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
    (!capabilities.includes("command") ||
      (Array.isArray(commands) && commands.length > 0)) &&
    declaredCommandWaits(declaration, capabilities)
  );
}

function isCommandWait(value: unknown): value is CommandWaitDeclaration {
  const wait = record(value);
  if (!keys(wait, ["command", "maximumWaitSeconds", "pollEverySeconds"]))
    return false;
  return (
    typeof wait["command"] === "string" &&
    integer(wait["maximumWaitSeconds"], { minimum: 60, maximum: 2_592_000 }) &&
    integer(wait["pollEverySeconds"], { minimum: 60, maximum: 86_400 }) &&
    Number(wait["pollEverySeconds"]) <= Number(wait["maximumWaitSeconds"])
  );
}

export function isCommandWaits(
  value: unknown,
  permissions: {
    readonly capabilities: readonly string[];
    readonly commands: readonly string[];
  },
): value is CommandWaits {
  const waits = record(value);
  if (waits === undefined) return false;
  return Object.entries(waits).every(
    ([name, wait]) =>
      matches(name, /^[A-Za-z0-9-]{1,64}$/) &&
      name.trim() === name &&
      isCommandWait(wait) &&
      permissions.capabilities.includes("command") &&
      permissions.commands.includes(wait.command),
  );
}

function declaredCommandWaits(
  declaration: Fields,
  capabilities: readonly string[],
): boolean {
  if (!Object.hasOwn(declaration, "commandWaits")) return true;
  const commands = declaration["commands"];
  return isCommandWaits(declaration["commandWaits"], {
    capabilities,
    commands: isWorkflowNames(commands) ? commands : [],
  });
}

export function isWorkflowDeclaration(
  value: unknown,
): value is WorkflowDeclaration {
  const declaration = record(value);
  if (
    !keys(declaration, [
      "workflowId",
      "effectLimit",
      "chainLimit",
      "spendLimitUsd",
      "capabilities",
      "input",
      "stages",
      "handoffs",
      "commands",
      "commandWaits",
      "queue",
      "schedule",
    ])
  )
    return false;
  const { workflowId, effectLimit, capabilities, input } = declaration;
  return (
    matches(workflowId, /^[A-Za-z0-9-]{1,64}$/) &&
    integer(effectLimit, { minimum: 1, maximum: 1000 }) &&
    declaredBudgets(declaration) &&
    isCapabilities(capabilities) &&
    declaredCommands(declaration, capabilities) &&
    isInput(input) &&
    declaredOptions(declaration, input)
  );
}

function declaredBudgets(declaration: Fields): boolean {
  const spend = declaration["spendLimitUsd"];
  return (
    (!Object.hasOwn(declaration, "chainLimit") ||
      integer(declaration["chainLimit"], { minimum: 2, maximum: 50 })) &&
    (!Object.hasOwn(declaration, "spendLimitUsd") ||
      (typeof spend === "number" && Number.isFinite(spend) && spend > 0))
  );
}

function declaredOptions(
  declaration: Fields,
  input: SubmissionContract,
): boolean {
  return (
    workflowQueueRefusals(declaration).length === 0 &&
    (!Object.hasOwn(declaration, "stages") ||
      isWorkflowStages(declaration["stages"])) &&
    (!Object.hasOwn(declaration, "handoffs") ||
      isWorkflowNames(declaration["handoffs"])) &&
    (!Object.hasOwn(declaration, "schedule") ||
      checkWorkflowSchedule(input, declaration["schedule"]).kind === "valid")
  );
}
