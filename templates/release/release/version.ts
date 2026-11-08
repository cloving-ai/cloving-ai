import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import type { ReleaseTask } from "./input.ts";
import { resultValue } from "./outcome.ts";

export interface ReleaseFeedback {
  readonly reason: string;
  readonly output: string;
}

export interface VersionState {
  readonly task: ReleaseTask;
  readonly base: string;
  readonly round: number;
  readonly feedback: ReleaseFeedback | null;
}

export async function prepareRelease(task: ReleaseTask): Promise<string> {
  const { base } = resultValue(
    await protectedEffect({
      scope: { phase: "version", operation: "github-prepare", round: 1 },
      capability: "github",
      method: "prepare",
      target: task.cycleId,
      payload: "{}",
      units: 1,
    }),
    "invalid-release-result",
  );
  if (
    typeof base !== "string" ||
    !/^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/.test(base)
  )
    throw new Error("invalid-release-result");
  return base;
}

function fixLines(state: VersionState): readonly string[] {
  const { feedback } = state;
  if (feedback === null) return [];
  return [
    "",
    `This is fix round ${String(state.round)}. Address ${feedback.reason}, then commit the fix. Keep the version ${state.task.version}.`,
    "",
    "Output:",
    feedback.output,
  ];
}

export function versionPrompt(state: VersionState): string {
  const { task, base } = state;
  return [
    `Prepare the release ${task.tag} in this worktree, on its current branch.`,
    `The main checkout at ${task.repository} is read-only.`,
    "Read AGENTS.md and CLAUDE.md.",
    `Set the version in package.json and in the lock file to ${task.version}, for example with npm version ${task.version} --no-git-tag-version --ignore-scripts. Change another file only when it must name the new version.`,
    `Write the release notes from the pull requests merged since the last tag. Find the last tag with git describe --tags --abbrev=0 origin/${base}.`,
    `List the changes since that tag with git log --first-parent --format=%B <last tag>..origin/${base}. This list holds merge commits, squash merges and rebase merges. Take the pull request number from the commit message, for example "Merge pull request #641" or "(#643)".`,
    "Check that npm ci --ignore-scripts accepts the lock file, then commit the change.",
    "Do not push, publish, deploy, tag, or switch branches.",
    "The branch will become a public pull request. Keep local paths out of tracked files and commit messages.",
    'End the report with the line "Release notes:" and then the release notes in Markdown, one line for each pull request.',
  ]
    .concat(fixLines(state))
    .join("\n");
}

export function releaseNotes(summary: unknown): string {
  if (typeof summary !== "string") throw new Error("invalid-release-report");
  const marker = "Release notes:";
  const index = summary.lastIndexOf(marker);
  const notes = index === -1 ? "" : summary.slice(index + marker.length).trim();
  if (notes === "") throw new Error("release-notes-missing");
  return notes;
}

export async function versionTurn(state: VersionState): Promise<string> {
  const { summary } = resultValue(
    await protectedEffect({
      scope: {
        phase: "version",
        operation: "claude-turn",
        round: state.round,
      },
      capability: "claude",
      method: "run-turn",
      target: state.task.cycleId,
      payload: versionPrompt(state),
      units: 1,
    }),
    "invalid-release-report",
  );
  return releaseNotes(summary);
}
