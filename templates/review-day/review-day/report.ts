import { fields } from "./facts.ts";

export interface Proposal {
  readonly id: string;
  readonly loop: string;
  readonly text: string;
  readonly evidence: readonly string[];
}

export interface ReviewReport {
  readonly facts: string;
  readonly wentWell: string;
  readonly wentBadly: string;
  readonly constraint: string;
  readonly improvementsInProgress: string;
  readonly proposals: readonly Proposal[];
  readonly watchList: string;
  readonly removed: readonly string[];
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error("invalid-review-report");
  return value;
}

function texts(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("invalid-review-report");
  return value.map((item: unknown) => text(item));
}

function proposal(value: unknown): Proposal {
  const item = fields(value);
  const loop = text(item["loop"]);
  const change = text(item["text"]);
  const heading = `Loop: ${loop}\n\n`;
  return {
    id: text(item["id"]),
    loop,
    text: change.startsWith(heading) ? change : heading + change,
    evidence: texts(item["evidence"]),
  };
}

export function parseReport(value: unknown): ReviewReport {
  const item = fields(value);
  const proposals = item["proposals"];
  if (!Array.isArray(proposals)) throw new Error("invalid-review-report");
  return {
    facts: text(item["facts"]),
    wentWell: text(item["wentWell"]),
    wentBadly: text(item["wentBadly"]),
    constraint: text(item["constraint"]),
    improvementsInProgress: text(item["improvementsInProgress"]),
    proposals: proposals.map((item: unknown) => proposal(item)),
    watchList: text(item["watchList"]),
    removed: texts(item["removed"]),
  };
}

export function renderReport(report: ReviewReport): string {
  const sections: readonly (readonly [string, string])[] = [
    ["Facts", report.facts],
    ["Went well", report.wentWell],
    ["Went badly", report.wentBadly],
    ["The constraint", report.constraint],
    ["Improvements in progress", report.improvementsInProgress],
    [
      "Proposals",
      report.proposals
        .map((proposal, index) => `${String(index + 1)}. ${proposal.text}`)
        .join("\n\n") || "None.",
    ],
    ["Watch list", report.watchList],
    ["Removed by the critique", report.removed.join("\n\n") || "None."],
  ];
  const text =
    "# Daily loop review\n\n" +
    sections.map(([heading, body]) => `## ${heading}\n\n${body}`).join("\n\n");
  if (text.length > 65536) throw new Error("review-report-too-large");
  return text;
}
