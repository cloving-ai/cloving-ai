import type { CycleOutcome } from "cloving/workflows";
import { handoff } from "cloving/workflows/steps/handoff";
import { issueOutcome, type IdeaInput } from "./effects.ts";
import type { PostedIssue } from "./post.ts";
import { queueIssue } from "./queue.ts";

export const targetWorkflow = "develop";

export async function handoffIssue(
  input: IdeaInput,
  issue: PostedIssue,
): Promise<CycleOutcome> {
  const outcome = issueOutcome(input, issue.number);
  try {
    await handoff({
      workflowId: targetWorkflow,
      input: { ticket: String(issue.number) },
    });
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : "handoff-failed";
    const reason = /^[a-z][a-z0-9-]{0,127}$/.test(message)
      ? message
      : "handoff-failed";
    try {
      await queueIssue(input, issue);
      return Object.assign(outcome, { reason });
    } catch {
      return Object.assign(outcome, { reason, issueUpdate: "failed" as const });
    }
  }
}
