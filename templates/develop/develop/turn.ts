import type { ProtectedResult } from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

export interface DevelopLessons {
  readonly text: string;
  readonly bytes: number;
}

export interface DevelopTurnInput {
  readonly cycleId: string;
  readonly repository: string;
  readonly ticket?: string;
  readonly prompt?: string;
  readonly round: number;
  readonly attempt?: "initial" | "continuation";
  readonly feedback: {
    readonly reason: string;
    readonly output: string;
    readonly remaining: readonly string[];
  } | null;
  readonly lessons?: DevelopLessons | null;
}

const lessonsLimit = 16384;

function lessonsSize(lessons: DevelopLessons): string {
  if (lessons.bytes === 0) return "The file is empty.";
  if (lessons.bytes <= lessonsLimit)
    return `The file has ${String(lessons.bytes)} bytes.`;
  return `The file has ${String(lessons.bytes)} bytes. This is more than the limit of ${String(lessonsLimit)} bytes. The text below is the first ${String(lessonsLimit)} bytes.`;
}

function lessonsPrompt(lessons: DevelopLessons | null | undefined): string[] {
  if (lessons === null || lessons === undefined) return [];
  return [
    "",
    "Lessons:",
    "The file .cloving/lessons.md keeps lessons from earlier runs of this repository. Use these lessons in this task.",
    "Before your last commit, you can add up to three new lessons from this run to the file:",
    "- Write each lesson on one line in ASD-STE100 Simplified Technical English, in the form - YYYY-MM-DD TICKET: lesson.",
    "- Use the date of today. Use the ticket ID from the title of the task, or the GitHub issue reference when the title has no ID.",
    "- Do not add a lesson that the file already has in the same or a similar form.",
    "- The lessons that earlier rounds of this run added count toward the three lessons.",
    `- When the file is larger than ${String(lessonsLimit)} bytes, join similar lessons and remove lessons that no longer apply, until the file is smaller than ${String(lessonsLimit)} bytes.`,
    "- Put the changes to the file in the same commit as the other changes, so that the review sees them.",
    "- Add no lesson when this run shows nothing new.",
    "",
    lessonsSize(lessons),
  ].concat(lessons.bytes === 0 ? [] : ["", lessons.text]);
}

function turnPrompt(input: DevelopTurnInput): string {
  if (!Number.isSafeInteger(input.round) || input.round < 1 || input.round > 6)
    throw new Error("invalid-development-round");
  const task = input.ticket ?? input.prompt;
  if (
    (input.ticket !== undefined && input.prompt !== undefined) ||
    typeof task !== "string" ||
    task.trim() === ""
  )
    throw new Error("invalid-development-task");
  const prompt = [
    "Implement the task in this worktree, on its current branch.",
    `The main checkout at ${input.repository} is read-only.`,
    "Read AGENTS.md and CLAUDE.md. Use TDD: observe the intended test failure before implementing each behavior.",
    "Run the repository checks, commit the changes, then run npm run check:clean if the repository provides it.",
    "Do not push, publish, deploy, or switch branches.",
    "The branch will become a public pull request. Keep local paths out of tracked files and commit messages.",
    "Report the changes and check results. Finish with Ticket status: complete or Ticket status: partial. For partial work, precede the status with Remaining: and one unfinished item per '- ' line.",
    "List as remaining only work that the task asks for. A check that the repository keeps fail-closed on purpose is not remaining work. A step that the task gives to the operator is not remaining work.",
  ]
    .concat(lessonsPrompt(input.lessons), ["", "Task:", task])
    .join("\n");
  if (input.feedback === null) return prompt;
  return [
    prompt,
    "",
    `This is fix round ${String(input.round)}. Address ${input.feedback.reason}, then commit the fix.`,
    "Reassess every unfinished item. Drop an item that the task does not ask for, and retain the unresolved items in the next Remaining: list:",
    input.feedback.remaining.map((item) => `- ${item}`).join("\n"),
    "",
    "Output from the previous result:",
    input.feedback.output,
  ].join("\n");
}

function attemptPrompt(input: DevelopTurnInput): string {
  const prompt = turnPrompt(input);
  if (input.attempt !== "continuation") return prompt;
  return [
    `The earlier turn of round ${String(input.round)} stopped before its report.`,
    "The work tree holds the work of that turn.",
    "Before you continue, check the work tree, the commits since the start of the round, and the ticket.",
    "",
    prompt,
  ].join("\n");
}

function turnScope(input: DevelopTurnInput) {
  if (input.attempt !== "continuation")
    return { phase: "implement", operation: "claude-turn", round: input.round };
  return {
    phase: "implement",
    operation: "claude-turn",
    round: input.round,
    key: "continuation",
  };
}

export async function developTurn(
  input: DevelopTurnInput,
): Promise<ProtectedResult> {
  return await protectedEffect({
    scope: turnScope(input),
    capability: "claude",
    method: "run-turn",
    target: input.cycleId,
    payload: attemptPrompt(input),
    units: 1,
  });
}
