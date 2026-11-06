export interface RescueInput {
  readonly cycleId: string;
  readonly repository: string;
  readonly input: {
    readonly pullRequest: number;
    readonly reason?: string;
    readonly issue?: string;
    readonly ticketStatus?: string;
  };
}

export interface RescueIssue {
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

export interface RescueTask {
  readonly cycleId: string;
  readonly repository: string;
  readonly pullRequest: number;
  readonly reason: string;
  readonly issue: RescueIssue | null;
  readonly complete: boolean;
}

function issueOf(text: string | undefined): RescueIssue | null {
  if (text === undefined) return null;
  const match = /^([\w.-]+)\/([\w.-]+)#([1-9]\d{0,9})$/.exec(text.trim());
  if (match === null) throw new Error("invalid-rescue-input");
  return {
    owner: String(match[1]),
    repository: String(match[2]),
    number: Number(match[3]),
  };
}

export function rescueTask(request: RescueInput): RescueTask {
  const { pullRequest, reason, issue, ticketStatus } = request.input;
  if (
    !Number.isSafeInteger(pullRequest) ||
    pullRequest < 1 ||
    ![undefined, "complete", "partial"].includes(ticketStatus)
  )
    throw new Error("invalid-rescue-input");
  return {
    cycleId: request.cycleId,
    repository: request.repository,
    pullRequest,
    reason: reason?.trim() || "unknown",
    issue: issueOf(issue),
    complete: ticketStatus === "complete",
  };
}
