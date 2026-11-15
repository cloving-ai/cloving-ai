import { isRecordKey } from "./authority/commands.ts";
import { record } from "./protocol.ts";

export interface QueueSettingRequest {
  readonly commandId: string;
  readonly scope: "global" | "workflow";
  readonly field: "lanes" | "workingLanes";
  readonly action: "set" | "inherit";
  readonly expectedValue: number;
  readonly value?: number | undefined;
  readonly workflowId?: string | undefined;
}

export function queueLaneValue(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 16
  );
}

export function queueSettingRequest(
  value: unknown,
): QueueSettingRequest | undefined {
  const body = record(value);
  if (body === undefined || !validIdentity(body)) return undefined;
  const { scope, field, action, workflowId } = body;
  if (scope !== "global" && scope !== "workflow") return undefined;
  if (!settingField(field)) return undefined;
  if (!settingTarget(scope, workflowId)) return undefined;
  if (action !== "set" && action !== "inherit") return undefined;
  const numeric = body["value"];
  if (!validValue(action, numeric)) return undefined;
  return {
    commandId: body["commandId"],
    scope,
    field,
    action,
    expectedValue: body["expectedValue"],
    ...optionalValues(body),
  };
}

function settingField(value: unknown): value is "lanes" | "workingLanes" {
  return value === "lanes" || value === "workingLanes";
}

function optionalValues(body: Readonly<Record<string, unknown>>) {
  return {
    ...(typeof body["workflowId"] === "string"
      ? { workflowId: body["workflowId"] }
      : {}),
    ...(queueLaneValue(body["value"]) ? { value: body["value"] } : {}),
  };
}

function validValue(action: string, value: unknown): boolean {
  return action === "set" ? queueLaneValue(value) : value === undefined;
}

function validIdentity(
  body: Readonly<Record<string, unknown>>,
): body is Readonly<Record<string, unknown>> & {
  readonly commandId: string;
  readonly expectedValue: number;
} {
  const known = [
    "commandId",
    "scope",
    "field",
    "action",
    "expectedValue",
    "value",
    "workflowId",
  ];
  return (
    isRecordKey(body["commandId"]) &&
    queueLaneValue(body["expectedValue"]) &&
    Object.keys(body).every((key) => known.includes(key))
  );
}

function settingTarget(scope: string, workflowId: unknown): boolean {
  if (scope === "global") return workflowId === undefined;
  return (
    typeof workflowId === "string" && /^[A-Za-z0-9-]{1,64}$/.test(workflowId)
  );
}
