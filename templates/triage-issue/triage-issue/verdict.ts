export interface TriageTask {
  readonly cycleId: string;
  readonly issue: number;
}

export interface Triage extends TriageTask {
  readonly verdict: string;
  readonly label: string;
  readonly body: string;
}

const verdictLine =
  /^Triage: (?:(duplicate) #([1-9]\d{0,9})|(bug|feature) (?:small|medium|large)|needs-information)$/;

export function triageOf(task: TriageTask, summary: string): Triage {
  const lines = summary.trimEnd().split(/\r?\n/);
  const last = lines.at(-1)?.trim() ?? "";
  const match = verdictLine.exec(last);
  if (match === null || Number(match[2]) === task.issue)
    throw new Error("invalid-triage-verdict");
  const reply = lines.slice(0, -1).join("\n").trim();
  if (reply === "") throw new Error("triage-reply-missing");
  return {
    cycleId: task.cycleId,
    issue: task.issue,
    verdict: last.slice("Triage: ".length),
    label: `cloving: ${match[1] ?? match[3] ?? "needs-information"}`,
    body: `${reply}\n\n${last}`,
  };
}
