import { record, type Fields } from "./protocol.ts";

export interface WorkReads {
  readonly runPage: (after: string) => Promise<Fields>;
  readonly openTurn: () => Promise<boolean>;
  readonly pendingSubmission: () => Promise<boolean>;
}

export interface Work {
  readonly activeRuns: number;
  readonly openTurn: boolean;
  readonly pendingSubmission: boolean;
}

const ended: readonly string[] = ["completed", "failed", "cancelled"];

function activeOn(page: Fields): number {
  const runs = page["runs"];
  if (!Array.isArray(runs)) throw new Error("invalid-run-list");
  return runs.filter((value: unknown) => {
    const run = record(value);
    if (run === undefined) throw new Error("invalid-run-status");
    return !ended.includes(String(run["state"]));
  }).length;
}

export async function workInProgress(reads: WorkReads): Promise<Work> {
  const pendingSubmission = await reads.pendingSubmission();
  const openTurn = await reads.openTurn();
  let activeRuns = 0;
  let after: string | null = "";
  do {
    const page = await reads.runPage(after);
    activeRuns += activeOn(page);
    const next = page["next"];
    if (next !== null && (typeof next !== "string" || next <= after))
      throw new Error("invalid-run-page");
    after = next;
  } while (after !== null);
  return { activeRuns, openTurn, pendingSubmission };
}

export function atGap(work: Work): boolean {
  return work.activeRuns === 0 && !work.openTurn && !work.pendingSubmission;
}
