import { record, type Fields } from "../protocol.ts";
import {
  isReportResultDigest,
  type ReportEffectResult,
  type ReportEffectResults,
} from "../report-effects.ts";
import { send } from "./client.ts";

interface ResultWindow {
  readonly start: number;
  readonly end: number;
}

interface StoredRead {
  readonly runId: string;
  readonly digest: string;
}

function effectKey(event: Fields): string {
  return JSON.stringify([
    event["runId"],
    record(event["payload"])?.["operationId"],
  ]);
}

function storedDigest(
  event: Fields,
  context: {
    readonly methods: ReadonlyMap<string, unknown>;
    readonly window: ResultWindow;
  },
): string | undefined {
  const digest = record(event["payload"])?.["result"];
  if (event["type"] !== "effect.reported" || !isReportResultDigest(digest))
    return undefined;
  const at = event["at"];
  if (typeof at !== "number" || !(at < context.window.end)) return undefined;
  const method = context.methods.get(effectKey(event));
  return method === "merge" ||
    (method === "wait-review" && at >= context.window.start)
    ? digest
    : undefined;
}

function storedReads(
  effects: readonly Fields[],
  window: ResultWindow,
): readonly StoredRead[] {
  const methods = new Map<string, unknown>();
  const reads = new Map<string, StoredRead>();
  for (const event of effects) {
    const runId = event["runId"];
    if (typeof runId !== "string") continue;
    const key = effectKey(event);
    if (event["type"] === "effect.requested" && !methods.has(key))
      methods.set(key, record(event["payload"])?.["method"]);
    const digest = storedDigest(event, { methods, window });
    if (digest !== undefined && !reads.has(digest))
      reads.set(digest, { runId, digest });
  }
  return [...reads.values()];
}

async function storedResult(
  runtime: string,
  read: StoredRead,
): Promise<ReportEffectResult> {
  const reply = await send(runtime, {
    operation: "effect-result",
    parameters: { runId: read.runId, digest: read.digest },
  });
  if (reply.kind === "error") return { reason: reply.error.code };
  const body = reply.result["result"];
  return typeof body === "string"
    ? { body }
    : { reason: "invalid-effect-result" };
}

export async function readReportEffectResults(
  runtime: string,
  input: {
    readonly effects: readonly Fields[];
    readonly window: ResultWindow;
  },
): Promise<ReportEffectResults> {
  const results: Record<string, ReportEffectResult> = {};
  const reads = storedReads(input.effects, input.window);
  for (let index = 0; index < reads.length; index += 4)
    await Promise.all(
      reads.slice(index, index + 4).map(async (read) => {
        results[read.digest] = await storedResult(runtime, read);
      }),
    );
  return results;
}
