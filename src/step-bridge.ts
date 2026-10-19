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

export type GateResult =
  | { readonly kind: "opened"; readonly decisionId: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface StepBridge {
  readonly effect: (request: ProtectedRequest) => Promise<ProtectedResult>;
  readonly gate: (request: GateRequest) => Promise<GateResult>;
}

export function isStepBridge(value: unknown): value is StepBridge {
  return ["effect", "gate"].every(
    (member) => typeof Reflect.get(Object(value), member) === "function",
  );
}
