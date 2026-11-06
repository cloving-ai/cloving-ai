import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import type { RescueTask } from "./input.ts";
import { resultValue, type RescueTree } from "./prepare.ts";

export interface RescueFeedback {
  readonly reason: string;
  readonly output: string;
}

export interface RescueState {
  readonly task: RescueTask;
  readonly tree: RescueTree;
  readonly round: number;
  readonly feedback: RescueFeedback;
}

function outputText(state: RescueState): string {
  const number = String(state.task.pullRequest);
  if (state.feedback.output.trim() !== "") return state.feedback.output;
  return `No output was given. Read the failed checks with gh pr checks ${number} and the review comments with gh pr view ${number} --comments. Do not change the pull request with gh.`;
}

export function rescuePrompt(state: RescueState): string {
  const { task, tree, round, feedback } = state;
  return [
    `Rescue pull request #${String(task.pullRequest)} in this worktree, on its current branch.`,
    `The main checkout at ${task.repository} is read-only.`,
    "Read AGENTS.md and CLAUDE.md.",
    `Merge the default branch origin/${tree.base} into this branch. Resolve each conflict, and keep the intent of both sides.`,
    "Fix the failed CI or the review findings in the output below. Use TDD: observe the intended test failure before you change a behavior.",
    "Run the repository checks, commit the changes, then run npm run check:clean if the repository provides it.",
    "Do not push, publish, deploy, or switch branches.",
    "The branch is a public pull request. Keep local paths out of tracked files and commit messages.",
    "Report the changes and the check results.",
    "",
    round === 1
      ? `The last run of this pull request stopped: ${feedback.reason}.`
      : `This is fix round ${String(round)}. Address ${feedback.reason}, then commit the fix.`,
    "",
    "Output:",
    outputText(state),
  ].join("\n");
}

export async function rescueTurn(state: RescueState): Promise<void> {
  const value = resultValue(
    await protectedEffect({
      scope: { phase: "rescue", operation: "claude-turn", round: state.round },
      capability: "claude",
      method: "run-turn",
      target: state.tree.target,
      payload: rescuePrompt(state),
      units: 1,
    }),
  );
  if (typeof value["summary"] !== "string")
    throw new Error("invalid-rescue-report");
}
