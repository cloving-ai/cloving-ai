import type { ReportDatum } from "../report-statistics.ts";
import type { WatchPrSettings } from "./watch-pr-settings.ts";

export interface ReportGithub {
  readonly observedSince: number | null;
  readonly issues: readonly ReportDatum[] | null;
  readonly pulls: readonly ReportDatum[] | null;
  readonly sources: Readonly<
    Record<
      "issues" | "pulls" | "history",
      { readonly status: string; readonly reason?: string }
    >
  >;
}

interface GithubReportInput {
  readonly since: string;
  readonly settings?: WatchPrSettings;
  readonly retryMilliseconds?: number;
}

export async function readReportGithub(
  input: GithubReportInput,
): Promise<ReportGithub> {
  const reader = await repositoryReader(input).catch(() => null);
  if (reader === null)
    return {
      observedSince: null,
      issues: null,
      pulls: null,
      sources: {
        issues: { status: "unavailable", reason: "configuration-or-identity" },
        pulls: { status: "unavailable", reason: "configuration-or-identity" },
        history: { status: "unavailable", reason: "configuration-or-identity" },
      },
    };
  const [issues, pulls, history] = await Promise.allSettled([
    issuesOf(reader, input.since),
    pullsOf(reader, input.since),
    repositoryCreatedAt(reader),
  ]);
  return {
    observedSince: history.status === "fulfilled" ? history.value : null,
    issues: issues.status === "fulfilled" ? issues.value : null,
    pulls: pulls.status === "fulfilled" ? pulls.value : null,
    sources: {
      issues: source(issues),
      pulls: source(pulls),
      history: source(history),
    },
  };
}

import { record, type Fields } from "../protocol.ts";
import { githubRetry } from "./github-retry.ts";
import { prRepository, type PrRepository } from "./watch-pr-identity.ts";

function commandOf(value: string | undefined): readonly string[] {
  const command: unknown = JSON.parse(value ?? '["gh"]');
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every(
      (part: unknown) =>
        typeof part === "string" && part !== "" && !part.includes("\0"),
    )
  )
    throw new Error("configuration");
  return command.map(String);
}

function rows(value: unknown): readonly Fields[] {
  if (!Array.isArray(value)) throw new Error("response");
  return value.map((item: unknown) => {
    const row = record(item);
    if (row === undefined) throw new Error("response");
    return row;
  });
}

function identity(
  row: Fields,
  context: {
    readonly repository: PrRepository;
    readonly kind: "issues" | "pull";
  },
): number {
  const { repository, kind } = context;
  const number = row["number"];
  const url = row["html_url"];
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    typeof url !== "string" ||
    url.toLowerCase() !==
      `https://${repository.host}/${repository.owner}/${repository.repository}/${kind}/${String(number)}`
  )
    throw new Error("identity");
  return number;
}

function timestamp(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("response");
  return Date.parse(value);
}

interface Reader {
  readonly repository: PrRepository;
  readonly read: (
    endpoint: string,
    flags?: readonly string[],
  ) => Promise<unknown>;
}

async function issuesOf(
  reader: Reader,
  since: string,
): Promise<readonly ReportDatum[]> {
  const result: ReportDatum[] = [];
  const seen = new Set<number>();
  for (let page = 1; ; page += 1) {
    const values = rows(
      await reader.read(
        `issues?state=closed&since=${encodeURIComponent(since)}&per_page=100&page=${String(page)}`,
        [
          "--jq",
          'map({number, html_url, closed_at, state, state_reason} + (if has("pull_request") then {pull_request: {}} else {} end))',
        ],
      ),
    );
    for (const row of values) {
      if (Object.hasOwn(row, "pull_request")) continue;
      const number = identity(row, {
        repository: reader.repository,
        kind: "issues",
      });
      if (seen.has(number)) throw new Error("response");
      seen.add(number);
      if (!completedIssue(row)) continue;
      result.push({
        at: timestamp(row["closed_at"]),
        value: 1,
        evidence: { issue: number },
      });
    }
    if (values.length < 100) return result;
  }
}

async function pullsOf(
  reader: Reader,
  since: string,
): Promise<readonly ReportDatum[]> {
  const result: ReportDatum[] = [];
  const seen = new Set<number>();
  for (let page = 1; ; page += 1) {
    const values = rows(
      await reader.read(
        `pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${String(page)}`,
      ),
    );
    for (const row of values) {
      const number = identity(row, {
        repository: reader.repository,
        kind: "pull",
      });
      if (seen.has(number)) throw new Error("response");
      seen.add(number);
      timestamp(row["updated_at"]);
      if (row["merged_at"] === null) continue;
      result.push({
        at: timestamp(row["merged_at"]),
        value: 1,
        evidence: { pullRequest: number },
      });
    }
    if (
      values.length < 100 ||
      values.some(
        (row) => Date.parse(String(row["updated_at"])) < Date.parse(since),
      )
    )
      return result;
  }
}

async function repositoryReader(input: GithubReportInput): Promise<Reader> {
  const settings = input.settings;
  if (settings?.repository === undefined) throw new Error("configuration");
  const command = commandOf(settings.githubCommand);
  const signal = AbortSignal.timeout(120_000);
  const origin = await settings.execute({
    command: ["git", "config", "--local", "--get-all", "remote.origin.url"],
    directory: settings.repository,
    signal,
  });
  const repository =
    origin.status === 0 && origin.errorCode === null
      ? prRepository(origin.stdout)
      : null;
  if (repository === null) throw new Error("identity");
  const directory = settings.repository;
  return {
    repository,
    read: async (endpoint, flags = []) => {
      const output = await githubRetry({
        signal,
        pollMilliseconds: input.retryMilliseconds ?? 30_000,
        action: async () => {
          const output = await settings.execute({
            directory,
            signal,
            command: [
              ...command,
              "api",
              "--method",
              "GET",
              "--hostname",
              repository.host,
              `repos/${repository.owner}/${repository.repository}${endpoint === "" ? "" : `/${endpoint}`}`,
              ...flags,
            ],
          });
          if (output.status !== 0 || output.errorCode !== null)
            throw Object.assign(new Error("github-call-failed"), {
              status: Number(/\(HTTP (\d{3})\)/.exec(output.stderr)?.[1]),
              detail: output.stderr,
            });
          return output.stdout;
        },
      });
      const parsed: unknown = JSON.parse(output);
      return parsed;
    },
  };
}

function source(result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") return { status: "available" };
  const reason =
    result.reason instanceof Error &&
    result.reason.message === "github-network-failed"
      ? "github-network-failed"
      : "read-failed";
  return { status: "unavailable", reason };
}

async function repositoryCreatedAt(reader: Reader): Promise<number> {
  const repository = record(await reader.read(""));
  const name = repository?.["full_name"];
  if (
    typeof name !== "string" ||
    name.toLowerCase() !==
      `${reader.repository.owner}/${reader.repository.repository}`
  )
    throw new Error("identity");
  return timestamp(repository?.["created_at"]);
}

function completedIssue(row: Fields): boolean {
  if (
    row["state"] !== "closed" ||
    !["completed", "not_planned", "duplicate"].includes(
      String(row["state_reason"]),
    )
  )
    throw new Error("response");
  return row["state_reason"] === "completed";
}
