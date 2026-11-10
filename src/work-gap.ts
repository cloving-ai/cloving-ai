import { record, type Fields } from "./protocol.ts";

export interface WorkReads {
  readonly runPage: (after: string) => Promise<Fields>;
  readonly openTurn: () => Promise<boolean>;
  readonly pendingSubmission: () => Promise<boolean>;
}

export interface Work {
  readonly activeRuns: number;
  readonly runIds: readonly string[];
  readonly openTurn: boolean;
  readonly pendingSubmission: boolean;
}

const ended: readonly string[] = ["completed", "failed", "cancelled"];

function activeOn(page: Fields): readonly string[] {
  const runs = page["runs"];
  if (!Array.isArray(runs)) throw new Error("invalid-run-list");
  return runs.flatMap((value: unknown) => {
    const run = record(value);
    if (run === undefined) throw new Error("invalid-run-status");
    return ended.includes(String(run["state"])) ? [] : [String(run["runId"])];
  });
}

export async function workInProgress(reads: WorkReads): Promise<Work> {
  const pendingSubmission = await reads.pendingSubmission();
  const openTurn = await reads.openTurn();
  const runIds: string[] = [];
  let after: string | null = "";
  do {
    const page = await reads.runPage(after);
    runIds.push(...activeOn(page));
    const next = page["next"];
    if (next !== null && (typeof next !== "string" || next <= after))
      throw new Error("invalid-run-page");
    after = next;
  } while (after !== null);
  return { activeRuns: runIds.length, runIds, openTurn, pendingSubmission };
}

export function atGap(work: Work): boolean {
  return work.activeRuns === 0 && !work.openTurn && !work.pendingSubmission;
}

export function gapLines(work: Work): readonly string[] {
  return [
    ...(work.runIds.length > 0
      ? [`Active runs: ${work.runIds.join(", ")}`]
      : []),
    ...(work.openTurn ? ["A worker turn is open."] : []),
    ...(work.pendingSubmission ? ["A queue submission is pending."] : []),
  ];
}

export interface KeepReads {
  readonly heldTurn: () => Promise<boolean>;
  readonly heldCommand: () => Promise<boolean>;
  readonly pendingSubmission: () => Promise<boolean>;
}

export async function heldWork(reads: KeepReads): Promise<readonly string[]> {
  const heldTurn = await reads.heldTurn();
  const heldCommand = await reads.heldCommand();
  const pendingSubmission = await reads.pendingSubmission();
  return [
    ...(heldTurn ? ["A worker turn cannot keep running."] : []),
    ...(heldCommand ? ["A command effect cannot keep running."] : []),
    ...(pendingSubmission ? ["A queue submission is pending."] : []),
  ];
}
