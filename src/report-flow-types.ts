export const reportOutcomes = [
  "completed",
  "partial",
  "blocked",
  "failed",
  "cancelled",
] as const;
export type ReportOutcome = (typeof reportOutcomes)[number];

export interface ReportCompletion {
  readonly runId: string;
  readonly sequence: number;
  readonly at: number;
  readonly outcome: ReportOutcome;
}

export interface ReportFlowRun {
  readonly runId: string;
  readonly workflowId: string | null;
  readonly start: number;
  readonly end: number | null;
}

export interface ReportFlow {
  readonly queue: {
    readonly workflowId: string;
    readonly lanes: number;
  } | null;
  readonly runs: readonly ReportFlowRun[] | null;
  readonly workflows?: readonly string[];
  readonly skips?:
    | readonly {
        readonly workflowId: string;
        readonly at: number;
        readonly sequence: number;
      }[]
    | null;
}

export interface ReportReadyTicket {
  readonly issue: number;
  readonly intervals: readonly {
    readonly start: number;
    readonly end: number | null;
  }[];
  readonly dependencies: readonly {
    readonly issue: number;
    readonly closedAt: number | null;
  }[];
}
