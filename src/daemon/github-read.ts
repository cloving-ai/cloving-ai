import type { GithubReader } from "../service/replies.ts";
import { calls } from "./github-calls.ts";

export function githubReader(settings: {
  readonly repository: string;
  readonly githubCommand?: readonly string[] | undefined;
}): GithubReader {
  const read = async (path: string): Promise<unknown> => {
    const github = calls(
      { repository: settings.repository, gh: settings.githubCommand ?? ["gh"] },
      AbortSignal.timeout(10_000),
    );
    const value: unknown = JSON.parse(await github.gh(["api", path]));
    return value;
  };
  return { read };
}
