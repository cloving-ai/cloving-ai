export const stepBridgeKey = "cloving.step-bridge/v1";

export interface ProtectedScope {
  readonly phase: string;
  readonly operation: string;
  readonly round: number;
  readonly key?: string;
  readonly stage?: {
    readonly id: string;
    readonly visit: string;
    readonly branch: string;
  };
}

export interface ProtectedRequest {
  readonly scope: ProtectedScope;
  readonly capability: string;
  readonly method: string;
  readonly target: string;
  readonly payload: string;
  readonly units: number;
  readonly resource?: string;
}

export type ProtectedResult =
  | {
      readonly kind: "completed";
      readonly operationId: string;
      readonly receipt: string | null;
      readonly result: string | null;
    }
  | {
      readonly kind: "failed" | "stopped" | "blocked" | "cancelled";
      readonly operationId: string;
      readonly reason: string | null;
    }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface GateRequest {
  readonly gateId: string;
  readonly kind: "question" | "approval";
  readonly prompt: string;
  readonly expiresAt?: string;
}

export interface DecisionResult {
  readonly decision: "approved" | "denied" | "answered" | "expired";
  readonly answer: string | null;
}

export type DecisionWait = { readonly token: string } | DecisionResult;

export type HandoffValue =
  | string
  | number
  | boolean
  | null
  | readonly HandoffValue[]
  | { readonly [key: string]: HandoffValue };

export interface HandoffRequest {
  readonly workflowId: string;
  readonly input: Readonly<Record<string, HandoffValue>>;
}

export interface RunWaitRequest {
  readonly runId: string;
  readonly maximumWaitSeconds: number;
}

export interface RunWaitOutcome {
  readonly kind: string;
  readonly reason: string | null;
  readonly promotionId: string | null;
}

export interface CommandWaitRequest {
  readonly name: string;
  readonly input: HandoffValue;
}

export type CommandWaitOutcome =
  | { readonly kind: "ready"; readonly value: HandoffValue }
  | {
      readonly kind: "timed-out" | "failed" | "refused" | "unavailable";
      readonly reason: string;
    };

export type CommandWaitProgress =
  | CommandWaitOutcome
  | {
      readonly kind: "pending";
      readonly deadline: number;
      readonly nextCheckAt: number;
    };

export interface CommandRequest {
  readonly scope: ProtectedScope;
  readonly name: string;
  readonly input: HandoffValue;
}

export type GateResult =
  | { readonly kind: "opened"; readonly decisionId: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface StepBridge {
  readonly openCommandWait?: (
    request: CommandWaitRequest,
  ) => Promise<CommandWaitProgress>;
  readonly checkCommandWait?: (request: {
    readonly name: string;
  }) => Promise<CommandWaitProgress>;
  readonly effect: (request: ProtectedRequest) => Promise<ProtectedResult>;
  readonly gate: (request: GateRequest) => Promise<GateResult>;
  readonly waitForDecision?: (request: GateRequest) => Promise<DecisionWait>;
  readonly handoff?: (request: HandoffRequest) => Promise<ProtectedResult>;
  readonly waitForRun?: (request: RunWaitRequest) => Promise<RunWaitOutcome>;
}

export function isStepBridge(value: unknown): value is StepBridge {
  return ["effect", "gate"].every(
    (member) => typeof Reflect.get(Object(value), member) === "function",
  );
}
