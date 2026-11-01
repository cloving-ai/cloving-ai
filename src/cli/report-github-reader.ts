import { record, type Fields } from "../protocol.ts";
import type { WatchPrSettings } from "./watch-pr-settings.ts";
import { githubRetry } from "./github-retry.ts";
import { prRepository, type PrRepository } from "./watch-pr-identity.ts";

export interface GithubReportInput {
  readonly since: string;
  readonly settings?: WatchPrSettings;
  readonly retryMilliseconds?: number;
}

export function reportSource(result: PromiseSettledResult<unknown>) {
  if (result.status === "fulfilled") return { status: "available" };
  const reason =
    result.reason instanceof Error &&
    result.reason.message === "github-network-failed"
      ? "github-network-failed"
      : "read-failed";
  return { status: "unavailable", reason };
}

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

export function rows(value: unknown): readonly Fields[] {
  if (!Array.isArray(value)) throw new Error("response");
  return value.map((item: unknown) => {
    const row = record(item);
    if (row === undefined) throw new Error("response");
    return row;
  });
}

export function identity(
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

export function timestamp(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("response");
  return Date.parse(value);
}

export interface Reader {
  readonly repository: PrRepository;
  readonly readNode: (nodeId: string) => Promise<unknown>;
  readonly readLog: (endpoint: string) => Promise<string>;
  readonly read: (
    endpoint: string,
    flags?: readonly string[],
  ) => Promise<unknown>;
}

export async function repositoryReader(
  input: GithubReportInput,
): Promise<Reader> {
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
  const timelines = new Map<string, Promise<unknown>>();
  return {
    repository,
    readNode: (nodeId) =>
      readEndpoint(input, {
        repository,
        command,
        endpoint: "",
        flags: [
          "-f",
          `query=query{node(id:${JSON.stringify(nodeId)}){id ... on ClosedEvent{stateReason}}}`,
        ],
        format: "graphql",
      }),
    readLog: async (endpoint) =>
      String(
        await readEndpoint(input, {
          repository,
          command,
          endpoint,
          flags: [],
          format: "text",
        }),
      ),
    read: (endpoint, flags = []) => {
      const key = JSON.stringify([endpoint, flags]);
      const cached = timelines.get(key);
      if (cached !== undefined) return cached;
      const reading = readEndpoint(input, {
        repository,
        command,
        endpoint,
        flags,
      });
      timelines.set(key, reading);
      return reading;
    },
  };
}

async function readEndpoint(
  input: GithubReportInput,
  request: {
    readonly repository: PrRepository;
    readonly command: readonly string[];
    readonly endpoint: string;
    readonly flags: readonly string[];
    readonly format?: "text" | "graphql";
  },
): Promise<unknown> {
  const settings = input.settings;
  if (settings?.repository === undefined) throw new Error("configuration");
  const { repository, command, endpoint, flags } = request;
  const directory = settings.repository;
  const signal = AbortSignal.timeout(120_000);
  const output = await githubRetry({
    signal,
    pollMilliseconds: input.retryMilliseconds ?? 30_000,
    action: async () => {
      const output = await settings.execute({
        outputBytes: request.format === "text" ? 2 * 1024 * 1024 : 1024 * 1024,
        directory,
        signal,
        command: [
          ...command,
          "api",
          "--method",
          request.format === "graphql" ? "POST" : "GET",
          "--hostname",
          repository.host,
          request.format === "graphql"
            ? "graphql"
            : `repos/${repository.owner}/${repository.repository}${endpoint === "" ? "" : `/${endpoint}`}`,
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
  if (request.format === "text")
    return Buffer.from(output)
      .subarray(0, 2 * 1024 * 1024)
      .toString("utf8");
  const parsed: unknown = JSON.parse(output);
  return parsed;
}

export async function issueTimeline(
  reader: Pick<Reader, "read">,
  issue: number,
): Promise<Fields[]> {
  const result: Fields[] = [];
  const seen = new Set<string>();
  for (let page = 1; ; page += 1) {
    const values = rows(
      await reader.read(
        `issues/${String(issue)}/timeline?per_page=100&page=${String(page)}`,
      ),
    );
    const signature = JSON.stringify(values);
    if (seen.has(signature)) throw new Error("response");
    seen.add(signature);
    result.push(...values);
    if (values.length < 100) return result;
  }
}
