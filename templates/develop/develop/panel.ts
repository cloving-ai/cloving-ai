import type {
  CycleOutcome,
  ProtectedResult,
  PullRequest,
} from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import type { DevelopReport, DevelopState } from "./report.ts";

export type PanelReviewer = "review-claude" | "review-codex" | "review-gemini";

export interface PanelRequest {
  readonly state: DevelopState;
  readonly report: DevelopReport;
  readonly pull: PullRequest;
  readonly reviewers: readonly PanelReviewer[];
}

export interface PanelReview {
  readonly accepted: boolean;
  readonly feedback: string;
  readonly findings: number;
}

export interface PanelTurn {
  readonly cycleId: string;
  readonly round: number;
  readonly commit: string;
  readonly subject: string;
}

type PanelReport =
  | {
      readonly profile: string;
      readonly verdict: "accept" | "change" | null;
      readonly summary: string;
    }
  | { readonly profile: string; readonly failure: string };

const verdictLines = [
  "End your report with exactly one of these lines:",
  "Review verdict: accept",
  "Review verdict: change",
];

export async function reviewPanel(
  request: PanelRequest,
): Promise<PanelReview | CycleOutcome> {
  const { state, pull, reviewers } = request;
  if (
    reviewers.length < 2 ||
    reviewers.some((name, index) => reviewers.indexOf(name) !== index)
  )
    throw new Error("invalid-review-panel");
  const turn = {
    cycleId: pull.target,
    round: state.round,
    commit: pull.commit,
    subject: panelSubject(request),
  };
  const reports = await panelReports({ turn: turn, reviewers: reviewers });
  if (reports.every((report) => "failure" in report))
    return unavailable(turn.cycleId);
  const synthesis = await synthesize({ turn: turn, reports: reports });
  return panelVerdict({ cycleId: turn.cycleId, result: synthesis });
}

export async function panelReports(request: {
  readonly turn: PanelTurn;
  readonly reviewers: readonly PanelReviewer[];
}): Promise<readonly PanelReport[]> {
  const { turn, reviewers } = request;
  const prompt = reviewerPrompt(turn);
  const claude = reviewers.includes("review-claude")
    ? await protectedEffect({
        scope: panelScope(turn, "review-claude"),
        capability: "claude",
        method: "run-turn:review-claude",
        target: turn.cycleId,
        payload: prompt,
        units: 1,
      })
    : null;
  const codex = reviewers.includes("review-codex")
    ? await protectedEffect({
        scope: panelScope(turn, "review-codex"),
        capability: "claude",
        method: "run-turn:review-codex",
        target: turn.cycleId,
        payload: prompt,
        units: 1,
      })
    : null;
  const gemini = reviewers.includes("review-gemini")
    ? await protectedEffect({
        scope: panelScope(turn, "review-gemini"),
        capability: "claude",
        method: "run-turn:review-gemini",
        target: turn.cycleId,
        payload: prompt,
        units: 1,
      })
    : null;
  return [
    { profile: "review-claude", result: claude },
    { profile: "review-codex", result: codex },
    { profile: "review-gemini", result: gemini },
  ].flatMap((entry) =>
    entry.result === null ? [] : [panelReport(entry.profile, entry.result)],
  );
}

export async function synthesize(request: {
  readonly turn: PanelTurn;
  readonly reports: readonly PanelReport[];
}): Promise<ProtectedResult> {
  const { turn, reports } = request;
  return await protectedEffect({
    scope: panelScope(turn, "review-synthesis"),
    capability: "claude",
    method: "run-turn:review-synthesis",
    target: turn.cycleId,
    payload: synthesisPrompt(turn, reports),
    units: 1,
  });
}

function panelScope(turn: PanelTurn, profile: string) {
  return { phase: "review", operation: `panel:${profile}`, round: turn.round };
}

function panelSubject(request: PanelRequest): string {
  const { state, report, pull } = request;
  const earlier =
    state.feedback === null
      ? ["There are no earlier findings. This is the first round."]
      : [
          `Findings of round ${String(state.round - 1)} (${state.feedback.reason}):`,
          state.feedback.output,
        ];
  return [
    `Review round ${String(state.round)} of pull request #${String(pull.number)}.`,
    `Inspect commit ${pull.commit}, not the current branch head.`,
    `Read the diff with: git diff origin/HEAD...${pull.commit}`,
    "",
    "Ticket:",
    state.input.ticket,
    "",
  ]
    .concat(earlier, [
      "",
      `Fix notes of round ${String(state.round)}:`,
      report.summary,
    ])
    .join("\n");
}

function reviewerPrompt(turn: PanelTurn): string {
  return [
    "You are one reviewer of a review panel. Do not change files, commit or push.",
    "List each finding with its file, its line and one reason.",
    "",
    turn.subject,
    "",
  ]
    .concat(verdictLines)
    .join("\n");
}

function synthesisPrompt(
  turn: PanelTurn,
  reports: readonly PanelReport[],
): string {
  return [
    "You are the synthesizer of a review panel. Do not change files, commit or push.",
    `Check each finding of the reports below against the current diff of commit ${turn.commit}.`,
    "List the findings that you keep and the findings that you drop, with one reason each.",
    "Drop each finding that the current change already fixes. Give the verdict change only for a finding that you keep.",
    "",
    turn.subject,
    "",
  ]
    .concat(reports.map(reportText), verdictLines)
    .join("\n");
}

function reportText(report: PanelReport): string {
  if ("failure" in report)
    return `${report.profile} gave no report (${report.failure}).\n`;
  return `Report of ${report.profile} (verdict: ${report.verdict ?? "none"}):\n${report.summary}\n`;
}

function panelReport(profile: string, result: ProtectedResult): PanelReport {
  if (result.kind !== "completed")
    return { profile, failure: result.reason ?? result.kind };
  const value: unknown = JSON.parse(result.result ?? "null");
  if (
    typeof value !== "object" ||
    value === null ||
    !("summary" in value) ||
    typeof value.summary !== "string"
  )
    return { profile, failure: "invalid-review-result" };
  return {
    profile,
    verdict: "reviewVerdict" in value ? verdictOf(value.reviewVerdict) : null,
    summary: value.summary,
  };
}

function verdictOf(value: unknown): "accept" | "change" | null {
  return value === "accept" || value === "change" ? value : null;
}

function panelVerdict(request: {
  readonly cycleId: string;
  readonly result: ProtectedResult;
}): PanelReview | CycleOutcome {
  const report = panelReport("review-synthesis", request.result);
  if ("failure" in report) return unavailable(request.cycleId);
  if (report.verdict === null)
    return {
      accepted: false,
      feedback: "The synthesizer turn has no verdict line.",
      findings: 0,
    };
  const accepted = report.verdict === "accept";
  return {
    accepted,
    feedback: report.summary,
    findings: !accepted && report.summary.trim() !== "" ? 1 : 0,
  };
}

function unavailable(cycleId: string): CycleOutcome {
  return {
    kind: "blocked",
    cycleId,
    reason: "review-panel-unavailable",
    evidenceId: "review",
  };
}
