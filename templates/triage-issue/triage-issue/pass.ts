import type { CycleOutcome } from "cloving/workflows";
import { handoff } from "cloving/workflows/steps/handoff";
import { runCommand } from "cloving/workflows/steps/run-command";
import { waitForRun } from "cloving/workflows/steps/wait-for-run";
import { resultText, type TriageInput } from "./input.ts";

interface TriageRun {
  readonly issue: number;
  readonly runId: string;
}

function issueNumber(item: unknown): number {
  if (typeof item !== "object" || item === null || !("number" in item))
    throw new Error("invalid-triage-candidates");
  const { number } = item;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
    throw new Error("invalid-triage-candidates");
  return number;
}

export function candidateIssues(text: string): readonly number[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("invalid-triage-candidates");
  }
  if (!Array.isArray(value)) throw new Error("invalid-triage-candidates");
  const numbers = value.map((item: unknown) => issueNumber(item));
  if (new Set(numbers).size !== numbers.length)
    throw new Error("invalid-triage-candidates");
  return numbers;
}

export async function triageCandidates(): Promise<readonly number[]> {
  const input: Readonly<Record<string, never>> = {};
  return candidateIssues(
    resultText(
      await runCommand({
        scope: { phase: "triage", operation: "triage-candidates", round: 1 },
        name: "triage-candidates",
        input: input,
      }),
    ),
  );
}

export async function triageRun(request: {
  readonly issue: number;
}): Promise<string> {
  return await handoff({
    workflowId: "triage-issue",
    input: { issue: request.issue },
  });
}

export async function handOffIssues(
  issues: readonly number[],
): Promise<readonly TriageRun[]> {
  const runs: TriageRun[] = [];
  for (let index = 0; index < 4; index += 1) {
    const issue = issues.at(index);
    if (issue !== undefined) {
      const runId = await triageRun({ issue: issue });
      runs.push({ issue: issue, runId: runId });
    }
  }
  return runs;
}

async function endedRun(run: TriageRun): Promise<string> {
  const outcome = await waitForRun({
    runId: run.runId,
    maximumWaitSeconds: 86400,
  });
  const reason = outcome.reason === null ? "" : ` (${outcome.reason})`;
  return `#${String(run.issue)} ${outcome.kind}${reason}`;
}

export async function triagePass(request: TriageInput): Promise<CycleOutcome> {
  const issues = await triageCandidates();
  const runs = await handOffIssues(issues);
  const ended: string[] = [];
  for (const run of runs) ended.push(await endedRun(run));
  return {
    kind: "handoff_requested",
    cycleId: request.cycleId,
    promotionId: "triage-pass",
    report: `Triage candidates: ${String(issues.length)}. Runs: ${ended.join(", ") || "none"}.`,
  };
}
