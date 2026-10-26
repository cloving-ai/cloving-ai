import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { workflowTestLoader } from "../tools/workflow-test-loader.ts";
import { authorizeEffect } from "./effect-authorization.ts";
import { record } from "./protocol.ts";
import {
  stepBridgeKey,
  type HandoffValue,
  type ProtectedResult,
  type ProtectedRequest,
  type GateResult,
  type RunWaitOutcome,
  type StepBridge,
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

export interface ScenarioResult {
  readonly spent?: number;
  readonly outcome: unknown;
  readonly requests: readonly (readonly [string, unknown])[];
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
  const requests: (readonly [string, unknown])[] = [];
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
      const result =
        scenario.effects === undefined
          ? scenario.turn
          : effects.get(request.capability + " " + request.method)?.shift();
      return Promise.resolve(refusal ?? result ?? unavailable);
    },
    gate: (request) => {
      requests.push(["gate", request]);
      return Promise.resolve(scenario.gate ?? unavailable);
    },
    handoff: (request) => {
      requests.push(["handoff", request]);
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
    readonly request: ProtectedRequest;
  },
): ProtectedResult | undefined {
  const { budget, request } = effect;
  if (scenario.effectLimit === undefined) return undefined;
  const allowed = authorizeEffect(
    { capabilities: ["claude", "github", "command"] },
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
  return `import { fakeStepBridge } from ${JSON.stringify(import.meta.url)};
import * as workflows from ${JSON.stringify(workflow)};
const given = ${JSON.stringify(scenario)};
const workflow = workflows[given.exportName];
if (typeof workflow !== "function") throw new Error("workflow-test-export-missing");
using bridge = fakeStepBridge(given);
const outcome = await workflow(given.input, given.decision);
process.stdout.write(JSON.stringify({ outcome, requests: bridge.requests,
  ...(given.effectLimit === undefined ? {} : { spent: bridge.spent }) }));`;
}

function scenarioResult(value: unknown): value is ScenarioResult {
  const result = record(value);
  return (
    result !== undefined &&
    Object.hasOwn(result, "outcome") &&
    Array.isArray(result["requests"]) &&
    result["requests"].every(
      (request: unknown) =>
        Array.isArray(request) &&
        request.length === 2 &&
        typeof request[0] === "string",
    ) &&
    (result["spent"] === undefined || typeof result["spent"] === "number")
  );
}

export async function runScenario(
  scenario: WorkflowScenario,
): Promise<ScenarioResult> {
  const temporary = await mkdtemp(join(tmpdir(), "cloving-scenario-"));
  try {
    const script = join(temporary, "scenario.mjs");
    await writeFile(script, scenarioScript(scenario));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--experimental-strip-types", "--import", workflowTestLoader(), script],
      { env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
    );
    const value: unknown = JSON.parse(stdout);
    if (!scenarioResult(value))
      throw new Error("invalid-workflow-scenario-result");
    return value;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
