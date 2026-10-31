import type {
  WatchCommandOutput,
  WatchCommandRequest,
} from "../src/cli/watch-pr-command.ts";
export const since = "2026-10-17T00:00:00.000Z";
export const output = (value: unknown): WatchCommandOutput => ({
  stdout: JSON.stringify(value),
  stderr: "",
  status: 0,
  errorCode: null,
});
export const issue = (
  number: number,
  extra: Readonly<Record<string, unknown>> = {},
) => ({
  number,
  html_url: `https://github.example/fixture/demo/issues/${String(number)}`,
  closed_at: "2026-10-24T12:00:00Z",
  state: "closed",
  state_reason: "completed",
  ...extra,
});
function projectedIssues(values: unknown, query: string | undefined) {
  if (
    query !==
    'map({number, html_url, closed_at, state, state_reason} + (if has("pull_request") then {pull_request: {}} else {} end))'
  )
    throw new Error("invalid-fixture-projection");
  if (!Array.isArray(values)) throw new Error("invalid-fixture-rows");
  return values.map((value: unknown) =>
    Object.fromEntries(
      Object.entries(value ?? {}).filter(([key]) =>
        [
          "number",
          "html_url",
          "closed_at",
          "state",
          "state_reason",
          "pull_request",
        ].includes(key),
      ),
    ),
  );
}

function issueOutput(
  request: WatchCommandRequest,
  input: { readonly pages: unknown; readonly limit: number | undefined },
): WatchCommandOutput {
  const { pages, limit } = input;
  const endpoint =
    request.command.find((part) => part.startsWith("repos/")) ?? "";
  const page = pageOf(endpoint);
  let values: unknown = pages;
  if (Array.isArray(pages) && !request.command.includes("--slurp"))
    values = page <= pages.length ? pages[page - 1] : [];
  const query = request.command.indexOf("--jq");
  if (query !== -1)
    values = projectedIssues(values, request.command[query + 1]);
  const result = output(values);
  return limit !== undefined && Buffer.byteLength(result.stdout) > limit
    ? {
        ...result,
        stdout: "",
        status: 1,
        errorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }
    : result;
}

interface GithubReportOptions {
  readonly timelineFailures?: readonly WatchCommandOutput[];
  readonly timelines?: Readonly<Record<number, readonly unknown[]>>;
  readonly issues?: unknown;
  readonly pulls?: unknown;
  readonly pullPages?: readonly unknown[];
  readonly failures?: readonly WatchCommandOutput[];
  readonly created?: string;
  readonly repositoryName?: string;
  readonly issueOutputLimit?: number;
}

export function githubReportFixture(options: GithubReportOptions = {}) {
  const commands: (readonly string[])[] = [];
  let attempts = 0;
  let timelineAttempts = 0;
  const issueRows = options.issues ?? [[]];
  const pullPages = options.pullPages ?? [options.pulls ?? []];
  const metadata = {
    full_name: options.repositoryName ?? "fixture/demo",
    created_at: options.created ?? "2026-01-01T00:00:00Z",
  };
  const execute = (
    request: WatchCommandRequest,
  ): Promise<WatchCommandOutput> => {
    commands.push(request.command);
    if (request.command[0] === "git")
      return Promise.resolve({
        ...output(null),
        stdout: "git@github.example:fixture/demo.git\n",
      });
    const endpoint =
      request.command.find((part) => part.startsWith("repos/")) ?? "";
    if (endpoint === "repos/fixture/demo")
      return Promise.resolve(output(metadata));
    if (endpoint.includes("/issues?")) {
      const failure = options.failures?.[attempts];
      attempts += 1;
      return Promise.resolve(
        failure ??
          issueOutput(request, {
            pages: issueRows,
            limit: options.issueOutputLimit,
          }),
      );
    }
    const page = pageOf(endpoint);
    const timeline = /issues\/(\d+)\/timeline/.exec(endpoint);
    if (timeline !== null) {
      const result = timelineOutput({
        options,
        issue: Number(timeline[1]),
        page,
        attempt: timelineAttempts,
      });
      timelineAttempts += 1;
      return Promise.resolve(result);
    }
    return Promise.resolve(output(pullPages[page - 1] ?? []));
  };
  return {
    commands,
    attempts: () => attempts,
    timelineAttempts: () => timelineAttempts,
    settings: {
      repository: "/fixture/repo",
      githubCommand: JSON.stringify(["fake-gh", "prefix"]),
      execute,
    },
  };
}

function pageOf(endpoint: string): number {
  return Number(/page=(\d+)$/.exec(endpoint)?.[1] ?? 1);
}

function timelineOutput(input: {
  readonly options: GithubReportOptions;
  readonly issue: number;
  readonly page: number;
  readonly attempt: number;
}): WatchCommandOutput {
  const failure = input.options.timelineFailures?.[input.attempt];
  const value = input.options.timelines?.[input.issue]?.[input.page - 1];
  return failure ?? output(value === undefined ? [] : value);
}
