import {
  prResponse,
  type PrFailure,
  type PrIdentity,
  type PrReadResult,
} from "./watch-pr-identity.ts";

export interface WatchCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly errorCode: string | null;
}

export interface WatchCommandRequest {
  readonly outputBytes?: number;
  readonly command: readonly string[];
  readonly directory: string;
  readonly signal: AbortSignal;
}

export type WatchCommandRunner = (
  request: WatchCommandRequest,
) => Promise<WatchCommandOutput>;

export function prArguments(identity: PrIdentity): readonly string[] {
  return [
    "api",
    "--method",
    "GET",
    "--hostname",
    identity.host,
    `repos/${identity.owner}/${identity.repository}/pulls/${String(identity.number)}`,
    "--include",
  ];
}

function commandFailure(output: WatchCommandOutput): PrFailure {
  const status = Number(
    /\(HTTP (\d{3})\)/.exec(output.stderr)?.[1] ??
      /^HTTP\/[^ ]+ (\d{3})/m.exec(output.stdout)?.[1],
  );
  if (
    status === 429 ||
    /rate limit/i.test(output.stderr) ||
    headerValues(output.stdout, "x-ratelimit-remaining").includes("0")
  )
    return "rate-limit";
  if (output.status === 4 || [401, 403, 404].includes(status)) return "access";
  return "command";
}

function headerValues(stdout: string, name: string): readonly string[] {
  if (!/^HTTP\/[^ ]+ \d{3}/.test(stdout)) return [];
  const headers = stdout.split(/\r?\n\r?\n/, 1)[0] ?? "";
  return headers.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf(":");
    return line.slice(0, separator).toLowerCase() === name
      ? [line.slice(separator + 1).trim()]
      : [];
  });
}

function millisecondsOf(value: string): readonly number[] {
  if (!/^\d+$/.test(value)) return [];
  const milliseconds = Number(value) * 1000;
  return Number.isSafeInteger(milliseconds) ? [milliseconds] : [];
}

function retryDeadline(output: WatchCommandOutput, now: number): number {
  const delays = headerValues(output.stdout, "retry-after")
    .flatMap(millisecondsOf)
    .map((delay) => now + delay)
    .filter(Number.isSafeInteger);
  const resets = headerValues(output.stdout, "x-ratelimit-remaining").includes(
    "0",
  )
    ? headerValues(output.stdout, "x-ratelimit-reset").flatMap(millisecondsOf)
    : [];
  const deadlines = [...delays, ...resets];
  return deadlines.length === 0 ? now + 60000 : Math.max(now, ...deadlines);
}

export function prCommandResult(
  identity: PrIdentity,
  reply: { readonly output: WatchCommandOutput; readonly now: number },
): PrReadResult {
  const { output, now } = reply;
  if (output.status !== 0 || output.errorCode !== null) {
    const failure = commandFailure(output);
    return {
      status: "unavailable",
      failure,
      ...(failure === "rate-limit"
        ? { retryAt: retryDeadline(output, now) }
        : {}),
    };
  }
  const envelope =
    /^HTTP\/[^ ]+ 200[^\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/.exec(
      output.stdout,
    );
  if (envelope?.[1] === undefined)
    return { status: "unavailable", failure: "response" };
  try {
    const response: unknown = JSON.parse(envelope[1]);
    return prResponse(identity, response);
  } catch {
    return { status: "unavailable", failure: "response" };
  }
}
