import {
  prResponse,
  type PrFailure,
  type PrIdentity,
  type PrObservation,
} from "./watch-pr-identity.ts";

export interface WatchCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly errorCode: string | null;
}

export interface WatchCommandRequest {
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
    /x-ratelimit-remaining: 0\s*$/im.test(output.stdout)
  )
    return "rate-limit";
  if (output.status === 4 || [401, 403, 404].includes(status)) return "access";
  return "command";
}

export function prCommandResult(
  identity: PrIdentity,
  output: WatchCommandOutput,
): PrObservation {
  if (output.status !== 0 || output.errorCode !== null)
    return { status: "unavailable", failure: commandFailure(output) };
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
