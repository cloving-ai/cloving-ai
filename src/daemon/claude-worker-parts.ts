import type { HarnessSettings, turnHarness } from "../harness-defaults.ts";
import type {
  AdapterOutcome,
  ProtectedIntent,
} from "../broker/actor/delivery-intents.ts";
import type { TurnSettings } from "../project-settings.ts";
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
}

export const claudeLimits = {
  summaryCharacters: 16_000,
  resultBytes: 48_000,
  stopMilliseconds: 15_000,
};

export interface Active {
  readonly worker: string;
  readonly intent: Pick<ProtectedIntent, "runId" | "operationId">;
  readonly turn: Promise<RetriedTurn>;
  readonly concluded: Promise<void>;
  readonly stopping: {
    requested: boolean;
    stoppedBy?: "daemon-shutdown";
    readonly controller: AbortController;
  };
}

export interface Parts {
  readonly reconciling: Map<string, Promise<AdapterOutcome>>;
  readonly settings: ClaudeWorkerSettings;
  readonly active: Map<string, Active>;
  readonly stopping: AbortController;
  readonly notes: NoteDesk;
}

export interface Started extends Located {
  readonly harness: ReturnType<typeof turnHarness>;
  readonly intent: ProtectedIntent;
  readonly tree: WorkTree;
  readonly turnSettings: TurnSettings;
  readonly noteIds: readonly string[];
}
