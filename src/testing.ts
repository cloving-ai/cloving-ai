import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { workflowTestLoader } from "../tools/workflow-test-loader.ts";
import { authorizeEffect, type EffectRequest } from "./effect-authorization.ts";
import { record } from "./protocol.ts";
import {
  stepBridgeKey,
  type HandoffValue,
  type ProtectedResult,
  type GateResult,
  type RunWaitOutcome,
  type StepBridge,
  type ProtectedRequest,
  type GateRequest,
  type HandoffRequest,
  type RunWaitRequest,
} from "./step-bridge.ts";

export interface StepScenario {
  readonly turn?: ProtectedResult;
  readonly effects?: Readonly<Record<string, readonly ProtectedResult[]>>;
  readonly gate?: GateResult;
  readonly waits?: readonly RunWaitOutcome[];
  readonly effectLimit?: number;
}

export interface WorkflowScenario extends StepScenario {
  readonly workflow: string;
  readonly exportName: string;
  readonly input: HandoffValue;
  readonly decision?: HandoffValue;
}

export type ScenarioRequest =
  | readonly ["effect", ProtectedRequest]
  | readonly ["gate", GateRequest]
  | readonly ["handoff", HandoffRequest]
  | readonly ["waitForRun", RunWaitRequest];

export interface ScenarioResult {
  readonly spent?: number;
  readonly outcome: unknown;
  readonly requests: readonly ScenarioRequest[];
}

export function fakeStepBridge(scenario: StepScenario) {
  const { bridge, requests, budget } = scenarioBridge(scenario);
  const key = Symbol.for(stepBridgeKey);
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  if (Reflect.get(globalThis, key) !== undefined)
    throw new Error("workflow-testing-host-active");
  Object.defineProperty(globalThis, key, { configurable: true, value: bridge });
  return {
    requests,
    get spent() {
      return budget.spent;
    },
    [Symbol.dispose]() {
      if (previous === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, previous);
    },
  };
}

function scenarioBridge(scenario: StepScenario) {
  const requests: ScenarioRequest[] = [];
  const effects = new Map(
    Object.entries(scenario.effects ?? {}).map(([key, values]) => [
      key,
      [...values],
    ]),
  );
  const waits = [...(scenario.waits ?? [])];
  const budget = { spent: 0 };
  const unavailable = {
    kind: "unavailable",
    reason: "no-scenario-result",
  } as const;
  const bridge: StepBridge = {
    effect: (request) => {
      requests.push(["effect", request]);
      const refusal = spend(scenario, { budget, request });
      if (refusal !== undefined) return Promise.resolve(refusal);
      const result =
        scenario.effects === undefined
          ? scenario.turn
          : effects.get(request.capability + " " + request.method)?.shift();
      return Promise.resolve(result ?? unavailable);
    },
    gate: (request) => {
      requests.push(["gate", request]);
      return Promise.resolve(scenario.gate ?? unavailable);
    },
    handoff: (request) => {
      requests.push(["handoff", request]);
      const refusal = spend(scenario, {
        budget,
        request: { capability: "handoff", units: 1 },
      });
      if (refusal !== undefined) return Promise.resolve(refusal);
      return Promise.resolve(
        effects.get("handoff")?.shift() ?? {
          kind: "completed",
          operationId: "handoff",
          receipt: null,
          result: "target-run",
        },
      );
    },
    waitForRun: (request) => {
      requests.push(["waitForRun", request]);
      return Promise.resolve(
        waits.shift() ?? {
          kind: "unavailable",
          reason: "no-scenario-result",
          promotionId: null,
        },
      );
    },
  };
  return { bridge, requests, budget };
}

function spend(
  scenario: StepScenario,
  effect: {
    readonly budget: { spent: number };
    readonly request: EffectRequest;
  },
): ProtectedResult | undefined {
  const { budget, request } = effect;
  if (scenario.effectLimit === undefined) return undefined;
  const allowed = authorizeEffect(
    { capabilities: ["claude", "github", "command", "handoff"] },
    {
      budget: { limit: scenario.effectLimit, spent: budget.spent },
      request,
    },
  );
  if (allowed.kind === "rejected")
    return { kind: "refused", reason: allowed.reason };
  budget.spent = allowed.spent;
  return undefined;
}

function scenarioScript(scenario: WorkflowScenario): string {
  const workflow = scenario.workflow.startsWith("file:")
    ? scenario.workflow
    : pathToFileURL(resolve(scenario.workflow)).href;
  return `import { writeFile } from "node:fs/promises";
import { fakeStepBridge } from ${JSON.stringify(import.meta.url)};
import * as workflows from ${JSON.stringify(workflow)};
const given = ${JSON.stringify(scenario)};
const workflow = workflows[given.exportName];
if (typeof workflow !== "function") throw new Error("workflow-test-export-missing");
using bridge = fakeStepBridge(given);
const outcome = await workflow(given.input, given.decision);
await writeFile(process.argv[2], JSON.stringify({ outcome, requests: bridge.requests,
  ...(given.effectLimit === undefined ? {} : { spent: bridge.spent }) }));`;
}

function scenarioResult(value: unknown): value is ScenarioResult {
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
  if (!Array.isArray(value) || value.length !== 2) return false;
  const request = record(value[1]);
  if (request === undefined) return false;
  switch (value[0]) {
    case "effect":
      return protectedRequest(request);
    case "gate":
      return gateRequest(request);
    case "handoff":
      return handoffRequest(request);
    case "waitForRun":
      return (
        typeof request["runId"] === "string" &&
        typeof request["maximumWaitSeconds"] === "number"
      );
    default:
      return false;
  }
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

export async function runScenario(
  scenario: WorkflowScenario,
): Promise<ScenarioResult> {
  const temporary = await mkdtemp(join(tmpdir(), "cloving-scenario-"));
  try {
    const script = join(temporary, "scenario.mjs");
    const resultFile = join(temporary, "result.json");
    await writeFile(script, scenarioScript(scenario));
    await executeScenario(script, resultFile);
    const value: unknown = JSON.parse(await readFile(resultFile, "utf8"));
    if (!scenarioResult(value))
      throw new Error("invalid-workflow-scenario-result");
    return value;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function executeScenario(script: string, resultFile: string): Promise<void> {
  return new Promise((settle, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        workflowTestLoader(),
        script,
        resultFile,
      ],
      {
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let diagnostics = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      diagnostics = (diagnostics + text).slice(-65536);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) settle();
      else
        reject(
          new Error(
            `workflow-scenario-failed: ${String(code ?? signal)}\n${diagnostics}`,
          ),
        );
    });
  });
}
