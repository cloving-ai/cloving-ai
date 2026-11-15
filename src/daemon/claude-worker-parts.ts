import type {
  Delivery,
  DeliveryIntent,
} from "../broker/actor/delivery-intents.ts";
import type { SteerAnswer, SteerRequest } from "./turn-steering.ts";
import { record } from "../protocol.ts";
import type { WorkerReconciliation } from "./worker-reconciliation.ts";
import type { HarnessSettings, turnHarness } from "../harness-defaults.ts";
import type { ProtectedIntent } from "../broker/actor/delivery-intents.ts";
import type { TurnSettings } from "../project-settings.ts";
import type { TurnRecovery } from "../turn-recovery.ts";
import type { Located, WorkerReport } from "./operation-journal.ts";
import type { RetriedTurn, RetrySettings } from "./retrying-turn.ts";
import type { NoteDesk, NotePort } from "./turn-notes.ts";
import type { WorkTree } from "./work-tree.ts";

export interface ClaudeWorkerSettings
  extends Pick<RetrySettings, "retryDelay" | "log">, HarnessSettings {
  readonly turnSettings: () => TurnSettings;
  readonly workflowId?: (runId: string) => Promise<string | undefined>;
  readonly repository: string;
  readonly worktrees: string;
  readonly journal: string;
  readonly command: readonly string[];
  readonly document: (digest: string) => Promise<string | undefined>;
  readonly report: (report: WorkerReport) => Promise<unknown>;
  readonly stopMilliseconds?: number;
  readonly notes?: NotePort;
  readonly recovered?: (recovery: TurnRecovery) => void;
}

export const claudeLimits = {
  summaryCharacters: 16_000,
  resultBytes: 48_000,
  stopMilliseconds: 15_000,
};

export function nativePiOperation(
  started: unknown,
  active: Active | undefined,
): boolean {
  if (active === undefined) return record(started)?.["piSession"] !== undefined;
  return active.worker === "pi" && active.output !== "text";
}

export function resumableActive(
  active: Pick<Active, "worker" | "output">,
): boolean {
  return (
    ["claude", "codex"].includes(active.worker) ||
    (active.worker === "pi" && active.output !== "text")
  );
}

export interface CloseOptions {
  readonly turns?: "keep" | "stop";
}

export interface Active {
  readonly output?: "text";
  readonly worker: string;
  readonly intent: Pick<ProtectedIntent, "runId" | "operationId" | "target">;
  readonly turn: Promise<RetriedTurn>;
  readonly concluded: Promise<void>;
  readonly stopping: {
    requested: boolean;
    stoppedBy?: "daemon-shutdown";
    readonly controller: AbortController;
  };
}

export interface Parts {
  readonly reconciling: WorkerReconciliation;
  readonly settings: ClaudeWorkerSettings;
  readonly active: Map<string, Active>;
  readonly stopping: AbortController;
  readonly release: AbortController;
  readonly notes: NoteDesk;
}

export interface Started extends Located {
  readonly harness: ReturnType<typeof turnHarness>;
  readonly intent: ProtectedIntent;
  readonly tree: WorkTree;
  readonly turnSettings: TurnSettings;
  readonly noteIds: readonly string[];
}

export interface ClaudeWorker extends Delivery {
  readonly hold: (intent: DeliveryIntent) => Promise<boolean>;
  readonly recover: (intent: DeliveryIntent) => Promise<void>;
  readonly harness: (operationId: string) => Promise<string | undefined>;
  readonly stop: NonNullable<Delivery["stop"]>;
  readonly steer: (request: SteerRequest) => Promise<SteerAnswer>;
  readonly close: (options?: CloseOptions) => Promise<void>;
}
