import { isInstant } from "./authority/instants.ts";
import { isCommandWaitRequest } from "./command-wait.ts";
import { record } from "./protocol.ts";
import type {
  HandoffValue,
  ProtectedRequest,
  GateRequest,
  HandoffRequest,
  RunWaitRequest,
  CommandWaitRequest,
} from "./step-bridge.ts";

export type ScenarioRequest =
  | readonly ["effect", ProtectedRequest]
  | readonly ["gate", GateRequest]
  | readonly ["waitForDecision", GateRequest]
  | readonly ["handoff", HandoffRequest]
  | readonly ["waitForRun", RunWaitRequest]
  | readonly ["waitForCommand", CommandWaitRequest]
  | readonly [
      "sleep",
      { readonly seconds: number } | { readonly until: string },
    ];

export interface ScenarioResult {
  readonly spent?: number;
  readonly outcome: unknown;
  readonly requests: readonly ScenarioRequest[];
}

export function scenarioResult(value: unknown): value is ScenarioResult {
  const result = record(value);
  return (
    result !== undefined &&
    Object.hasOwn(result, "outcome") &&
    Array.isArray(result["requests"]) &&
    result["requests"].every(scenarioRequest) &&
    (result["spent"] === undefined || typeof result["spent"] === "number")
  );
}

function scenarioRequest(value: unknown): value is ScenarioRequest {
  if (!requestPair(value)) return false;
  const request = record(value[1]);
  if (request === undefined) return false;
  switch (value[0]) {
    case "effect":
      return protectedRequest(request);
    case "gate":
    case "waitForDecision":
      return gateRequest(request);
    case "handoff":
      return handoffRequest(request);
    case "waitForRun":
      return runWaitRequest(request);
    case "waitForCommand":
      return isCommandWaitRequest(request);
    case "sleep":
      return sleepRequest(request);
    default:
      return false;
  }
}

function requestPair(value: unknown): value is readonly [unknown, unknown] {
  return Array.isArray(value) && value.length === 2;
}

function runWaitRequest(request: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof request["runId"] === "string" &&
    typeof request["maximumWaitSeconds"] === "number"
  );
}

function sleepRequest(request: Readonly<Record<string, unknown>>): boolean {
  if (typeof request["until"] === "string") return isInstant(request["until"]);
  const seconds = request["seconds"];
  return (
    typeof seconds === "number" &&
    Number.isInteger(seconds) &&
    seconds >= 1 &&
    seconds <= 86400
  );
}

function gateRequest(request: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof request["gateId"] === "string" &&
    (request["kind"] === "question" || request["kind"] === "approval") &&
    typeof request["prompt"] === "string" &&
    optionalText(request["expiresAt"])
  );
}

function handoffRequest(request: Readonly<Record<string, unknown>>): boolean {
  const input = record(request["input"]);
  return (
    typeof request["workflowId"] === "string" &&
    input !== undefined &&
    Object.values(input).every(handoffValue)
  );
}

function protectedRequest(request: Readonly<Record<string, unknown>>): boolean {
  return (
    protectedScope(request["scope"]) &&
    ["capability", "method", "target", "payload"].every(
      (key) => typeof request[key] === "string",
    ) &&
    typeof request["units"] === "number" &&
    optionalText(request["resource"])
  );
}

function protectedScope(value: unknown): boolean {
  const scope = record(value);
  if (scope === undefined) return false;
  const stage = record(scope["stage"]);
  return (
    typeof scope["phase"] === "string" &&
    typeof scope["operation"] === "string" &&
    typeof scope["round"] === "number" &&
    optionalText(scope["key"]) &&
    (scope["stage"] === undefined ||
      (stage !== undefined &&
        ["id", "visit", "branch"].every(
          (key) => typeof stage[key] === "string",
        )))
  );
}

function optionalText(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function handoffValue(value: unknown): value is HandoffValue {
  if (value === null || ["string", "boolean", "number"].includes(typeof value))
    return true;
  if (Array.isArray(value)) return value.every(handoffValue);
  const fields = record(value);
  return fields !== undefined && Object.values(fields).every(handoffValue);
}
