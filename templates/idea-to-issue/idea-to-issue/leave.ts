import type { CycleOutcome } from "cloving/workflows";
import { issueOutcome, type IdeaInput } from "./effects.ts";
import type { PostedIssue } from "./post.ts";

export async function leaveIssue(
  input: IdeaInput,
  issue: PostedIssue,
): Promise<CycleOutcome> {
  return Promise.resolve(issueOutcome(input, issue.number));
}
