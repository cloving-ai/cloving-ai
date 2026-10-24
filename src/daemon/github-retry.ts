import { setTimeout as delay } from "node:timers/promises";
import { field, githubTiming, type Operation } from "./github-operation.ts";

function transient(error: unknown): boolean {
  if (!(error instanceof Error) || error.message !== "github-call-failed")
    return false;
  const detail = field(error, "detail");
  if (typeof detail !== "string") return false;
  const status = field(error, "status");
  if ([500, 502, 503, 504].includes(Number(status))) return true;
  return (
    (status === undefined ||
      (typeof status === "number" && Number.isNaN(status))) &&
    /TLS handshake timeout|connection reset|i\/o timeout|\bEOF\b/i.test(detail)
  );
}

function retryFactor(
  error: unknown,
  retry: { readonly attempt: number; readonly statuses: readonly number[] },
): number {
  const network = transient(error);
  if (!network && !retry.statuses.includes(Number(field(error, "status"))))
    throw error;
  if (retry.attempt < 2) return network ? retry.attempt + 1 : 1;
  if (!network) throw error;
  throw Object.assign(new Error("github-network-failed", { cause: error }), {
    detail: field(error, "detail"),
  });
}

export async function retryGithub<Result>(
  operation: Operation,
  retry: {
    readonly action: (attempt: number) => Promise<Result>;
    readonly statuses?: readonly number[];
  },
): Promise<Result> {
  const timing = operation.settings.timing ?? githubTiming;
  for (let attempt = 0; ; attempt += 1) {
    operation.signal.throwIfAborted();
    try {
      return await retry.action(attempt);
    } catch (error) {
      operation.signal.throwIfAborted();
      const factor = retryFactor(error, {
        attempt,
        statuses: retry.statuses ?? [],
      });
      await delay(timing.pollMilliseconds * factor, undefined, {
        signal: operation.signal,
      });
    }
  }
}

export function githubRead(
  operation: Operation,
  parts: readonly string[],
): Promise<string> {
  return retryGithub(operation, { action: () => operation.calls.gh(parts) });
}
