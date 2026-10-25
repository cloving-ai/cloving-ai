import { githubRetry } from "../cli/github-retry.ts";
import { githubTiming, type Operation } from "./github-operation.ts";

export function retryGithub<Result>(
  operation: Operation,
  retry: {
    readonly action: (attempt: number) => Promise<Result>;
    readonly statuses?: readonly number[];
  },
): Promise<Result> {
  return githubRetry({
    ...retry,
    signal: operation.signal,
    pollMilliseconds: (operation.settings.timing ?? githubTiming)
      .pollMilliseconds,
  });
}

export function githubRead(
  operation: Operation,
  parts: readonly string[],
): Promise<string> {
  return retryGithub(operation, { action: () => operation.calls.gh(parts) });
}
