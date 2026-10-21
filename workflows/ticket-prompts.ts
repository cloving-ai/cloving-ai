import { ticketStatus } from "cloving/workflows";

export interface Ticket {
  readonly cycleId: string;
  readonly ticket: string;
  readonly ticketId?: string;
  readonly repository: string;
  readonly delivery?: string;
}

export interface Round {
  readonly number: number;
  readonly feedback: string | null;
}

export interface Pull {
  readonly number: number;
  readonly url: string;
  readonly commit: string;
}

export interface Fix {
  readonly round: number;
  readonly pull: Pull;
  readonly review: Fields;
  readonly report: Fields;
}

export const lastRound = 3;
const publicRule =
  "The branch becomes a public pull request. Do not write local file paths, such as the path of your home folder, in files or in commit messages.";

type Fields = Readonly<Record<string, unknown>>;

function instructions(repository: string): string {
  return [
    "You work on one ticket of this repository. Your current directory is a git work tree on its own branch.",
    `The main repository is at ${repository}. Do not change files there.`,
    `If this work tree has no node_modules folder and the main repository has one, make a copy-on-write clone: cp -c -R ${repository}/node_modules node_modules`,
    "Follow the instructions of the repository (AGENTS.md and CLAUDE.md).",
    "Use test-driven development: write a test that fails, see it fail, then write the code.",
    "Run the checks of the repository before you finish. Commit your work before the report. If the repository provides npm run check:clean, run it after committing.",
    "Commit your work on the current branch. Do not push. Do not change a different branch.",
    "End with a short report: what you changed, the checks that you ran with their results, and what is not done. End the report with exactly one of the lines Ticket status: complete or Ticket status: partial. Before a partial status line, include Remaining: followed by a list with one item on each line, using a dash and a space before each item. Blank lines are allowed around and between list items.",
  ].join("\n");
}

function named(input: Ticket): string {
  return input.ticketId === undefined
    ? "this ticket"
    : `the ticket ${input.ticketId}`;
}

export function fields(text: string | null): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(text ?? "{}");
  return typeof value === "object" && value !== null ? { ...value } : {};
}

export function part(
  turn: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = turn[name];
  if (Array.isArray(value)) return value.join("\n");
  if (typeof value === "number") return value.toFixed(2);
  return typeof value === "string" ? value : "";
}

function denial(round: number): string {
  return round < lastRound
    ? "Deny with a feedback text to send the work back to the worker for one more round. Deny with no text to reject the work."
    : "Deny to reject the work. This is the last round.";
}

export function review(
  input: Ticket,
  turnResult: { readonly round: number; readonly result: string | null },
): string {
  const turn = fields(turnResult.result);
  return [
    `Review the work of the Claude worker for ${named(input)}.`,
    `Round: ${String(turnResult.round)} of ${String(lastRound)}`,
    `Branch: ${part(turn, "branch")}`,
    `Work tree: ${part(turn, "worktree")}`,
    `Cost (USD): ${part(turn, "costUsd")}`,
    "",
    "Commits:",
    part(turn, "commits"),
    "",
    "Changed files:",
    part(turn, "files"),
    "",
    "Not committed:",
    part(turn, "uncommitted"),
    "",
    "Report of the worker:",
    part(turn, "summary"),
    "",
    "Approve to accept the branch, then merge the branch yourself.",
    denial(turnResult.round),
  ].join("\n");
}

export function prompt(input: Ticket, round: Round): string {
  const ticket = `${instructions(input.repository)}\n\nThe text of ${named(input)}:\n\n${input.ticket}`;
  if (round.feedback === null) return ticket;
  return `${ticket}\n\nThis is round ${String(round.number)}. The branch has the commits of the earlier rounds. The operator denied the work of round ${String(round.number - 1)} with this feedback:\n\n${round.feedback}`;
}

function pullPrompt(input: Ticket): string {
  return `${instructions(input.repository)}\n${publicRule}\n\nThe text of ${named(input)}:\n\n${input.ticket}`;
}

function findingLines(findings: unknown): string {
  if (!Array.isArray(findings)) return "";
  return findings
    .map((item: unknown) => {
      const finding = fields(JSON.stringify(item));
      const line = finding["line"];
      const place = typeof line === "number" ? `:${String(line)}` : "";
      return `- ${part(finding, "path")}${place}: ${part(finding, "body")}`;
    })
    .join("\n");
}

export function turnPrompt(input: Ticket, fix: Fix | null): string {
  if (fix === null) return pullPrompt(input);
  const { round, pull, review } = fix;
  const status = ticketStatus(
    part(fix.report, "summary"),
    fix.report["ticketStatus"],
  );
  const continuation =
    status.kind === "complete"
      ? ""
      : [
          "",
          "Remaining work from the previous worker report:",
          ...status.remaining.map((item) => `- ${item}`),
          "Reassess each remaining item before reporting Ticket status: complete. Keep every unfinished item in the next Remaining: list.",
        ].join("\n");
  const ticket = pullPrompt(input) + continuation;
  if (typeof review["reason"] === "string")
    return [
      ticket,
      "",
      `This is round ${String(round)}. The merge of the pull request ${pull.url} needs a fix: ${review["reason"]}.`,
      review["reason"] === "merge-conflict"
        ? "Merge the default branch of origin into the branch, resolve each conflict, run the tests, and commit."
        : "The check failed on the tree of the merge of the branch with the newest commit of the default branch. Fix the cause and commit the fix.",
      "",
      part(review, "output"),
    ].join("\n");
  return [
    ticket,
    "",
    `This is round ${String(round)}. The branch has the commits of the earlier rounds. Greptile reviewed the pull request ${pull.url} at the commit ${pull.commit.slice(0, 7)} and gave the confidence score ${String(review["score"])}/5. Fix each problem of the review, then commit the fixes. Cloving merges the pull request when the score is 5/5.`,
    "",
    "Summary of the review:",
    "",
    part(review, "summary"),
    "",
    "Findings on lines:",
    "",
    findingLines(review["findings"]),
  ].join("\n");
}

export function pullTitle(input: Ticket): string {
  const [first = ""] = input.ticket.split("\n", 1);
  return first.startsWith("# ")
    ? first.slice(2).trim().slice(0, 200)
    : `Cloving task ${input.cycleId}`;
}

export function pullBody(input: Ticket): string {
  const issue = /^GitHub issue: ([\w.-]+[/][\w.-]+#\d+)/m.exec(input.ticket);
  const about = `Cloving made this change for ${named(input)}. Greptile reviews the pull request, and Cloving merges it when the confidence score is 5/5.`;
  return issue === null ? about : `Refs ${String(issue[1])}\n\n${about}`;
}
