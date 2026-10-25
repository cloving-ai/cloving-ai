import { setTimeout as delay } from "node:timers/promises";
function field(value: unknown, name: string): unknown {
  return Reflect.get(Object(value), name);
}

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

export async function githubRetry<Result>(retry: {
  readonly signal: AbortSignal;
  readonly pollMilliseconds: number;
  readonly action: (attempt: number) => Promise<Result>;
  readonly statuses?: readonly number[];
}): Promise<Result> {
  for (let attempt = 0; ; attempt += 1) {
    retry.signal.throwIfAborted();
    try {
      return await retry.action(attempt);
    } catch (error) {
      retry.signal.throwIfAborted();
      const factor = retryFactor(error, {
        attempt,
        statuses: retry.statuses ?? [],
      });
      await delay(retry.pollMilliseconds * factor, undefined, {
        signal: retry.signal,
      });
    }
  }
}
