import type { Validation } from "./workflow-contracts.ts";

const component = /^[A-Za-z0-9._:/-]{1,128}$/;

export function operationIdentity(value: unknown): Validation<string> {
  const scope = fields(value);
  const round = scope["round"];
  const stage = optionalStage(scope["stage"]);
  const key = scope["key"];
  const required = [scope["run"], scope["phase"], scope["operation"]];
  if (
    typeof round !== "number" ||
    !Number.isSafeInteger(round) ||
    round < 0 ||
    stage === undefined ||
    !required.every(isComponent) ||
    (key !== undefined && !isComponent(key))
  )
    return { kind: "invalid", reason: "invalid-operation-scope" };
  return {
    kind: "valid",
    value: JSON.stringify([
      "cloving-operation",
      round,
      ...required,
      stage,
      key ?? null,
    ]),
  };
}

function optionalStage(value: unknown): readonly string[] | null | undefined {
  if (value === undefined) return null;
  const stage = fields(value);
  const [id, visit, branch] = [stage["id"], stage["visit"], stage["branch"]];
  if (!isComponent(id) || !isComponent(visit) || !isComponent(branch))
    return undefined;
  return [id, visit, branch];
}

function isComponent(value: unknown): value is string {
  return typeof value === "string" && component.test(value);
}

function fields(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

export interface OperationScope {
  readonly run: string;
  readonly operation: string;
}

export function operationScope(operationId: string): OperationScope | null {
  const [marker, , run, , operation] = parsedList(operationId);
  if (marker !== "cloving-operation") return null;
  if (!isComponent(run) || !isComponent(operation)) return null;
  return { run, operation };
}

function parsedList(text: string): readonly unknown[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
