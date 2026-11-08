import type { PullRequest } from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import type { ReleaseTask } from "./input.ts";
import { resultValue } from "./outcome.ts";

export function pullBody(request: {
  readonly task: ReleaseTask;
  readonly notes: string;
}): string {
  const { task, notes } = request;
  return `Set the version to ${task.version} for the release ${task.tag}.\n\n## Release notes\n\n${notes}`;
}

export async function openVersionPull(request: {
  readonly task: ReleaseTask;
  readonly round: number;
  readonly notes: string;
}): Promise<PullRequest> {
  const { task, round } = request;
  const { number, url, commit } = resultValue(
    await protectedEffect({
      scope: { phase: "version", operation: "github-open-pr", round: round },
      capability: "github",
      method: "open-pr",
      target: task.cycleId,
      payload: JSON.stringify({
        title: `Release ${task.tag}`,
        body: pullBody(request),
        replaceBody: true,
      }),
      units: 1,
    }),
    "invalid-pull-request",
  );
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    typeof url !== "string" ||
    typeof commit !== "string" ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)
  )
    throw new Error("invalid-pull-request");
  return { number, url, commit, target: task.cycleId };
}
