export interface VerificationInputs {
  readonly source: readonly string[];
  readonly tests: readonly string[];
  readonly dependencies: readonly string[];
  readonly tools: readonly string[];
  readonly policy: readonly string[];
  readonly exceptions: readonly string[];
}

export interface VerificationSnapshot {
  readonly identity: string;
  readonly groups: Readonly<Record<string, readonly string[]>>;
}

export interface VerificationCommand {
  readonly id: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly directory: string;
  readonly timeoutMilliseconds: number;
}

export interface VerificationPlan {
  readonly requiredChecks: readonly string[];
  readonly commands: readonly VerificationCommand[];
}

export interface CapturedExecution {
  readonly id: string;
  readonly processGroup: number | null;
  readonly exit: number | null;
  readonly signal: string | null;
  readonly error: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VerificationReceipt {
  readonly authority: "diagnostic-only";
  readonly identity: string;
  readonly inputs: string;
  readonly inventory: VerificationSnapshot;
  readonly plan: VerificationPlan;
  readonly executions: readonly CapturedExecution[];
}
