import type { ScheduleInvocation } from "./schedule-arguments.ts";
import type { QueueInvocation } from "./queue-arguments.ts";
import type { ContinueInvocation } from "./continue-arguments.ts";
import type { RestartInvocation } from "./restart-arguments.ts";

export type RunSource =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "ticket"; readonly id: string }
  | { readonly kind: "input"; readonly file: string };

export type DecisionCommand = "answer" | "approve" | "deny";

export type RunCommand = "pause" | "resume" | "drop";

export type RuntimeInvocation =
  | ScheduleInvocation
  | QueueInvocation
  | ContinueInvocation
  | RestartInvocation
  | { readonly kind: "report"; readonly since: number; readonly json: boolean }
  | { readonly kind: "reload"; readonly json: boolean }
  | {
      readonly kind: "dismiss";
      readonly runId: string;
      readonly commandId: string | null;
      readonly json: boolean;
    }
  | { readonly kind: "command-help"; readonly command: string }
  | {
      readonly kind: "run";
      readonly workflowId: string;
      readonly source: RunSource;
      readonly commandId: string | null;
      readonly json: boolean;
    }
  | {
      readonly kind: "status";
      readonly runId: string | null;
      readonly limit: number | null;
      readonly after: string | null;
      readonly active: boolean;
      readonly json: boolean;
    }
  | {
      readonly kind: "questions";
      readonly runId: string | null;
      readonly json: boolean;
    }
  | {
      readonly kind: "decision";
      readonly command: DecisionCommand;
      readonly reference: string;
      readonly text: string | null;
      readonly expectedRevision: number;
      readonly generation: number;
      readonly subjectDigest: string;
      readonly commandId: string | null;
      readonly json: boolean;
    }
  | {
      readonly kind: "run-command";
      readonly command: RunCommand;
      readonly runId: string;
      readonly expectedRevision: number;
      readonly commandId: string | null;
      readonly json: boolean;
    }
  | {
      readonly kind: "events";
      readonly runId: string | null;
      readonly after: number;
      readonly limit: number | null;
      readonly follow: boolean;
      readonly json: boolean;
    }
  | {
      readonly kind: "watch";
      readonly port: number | null;
      readonly json: boolean;
      readonly workspace?: true;
    };

export interface GivenOption {
  readonly name: string;
  readonly value: string | undefined;
}

export interface RuntimeRequest {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly options: readonly GivenOption[];
}

export const argumentRules = {
  identifier: /^[A-Za-z0-9._:/-]{1,128}$/,
  decisionReference: /^[A-Za-z0-9._:/-]{1,256}$/,
  sha256Digest: /^sha256:[0-9a-f]{64}$/,
  revisions: { minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
};
