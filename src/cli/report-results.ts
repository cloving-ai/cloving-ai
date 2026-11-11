import { record, type Fields } from "../protocol.ts";
import {
  isReportResultDigest,
  type ReportEffectResult,
  type ReportEffectResults,
} from "../report-effects.ts";
import { send } from "./client.ts";

const storedMethods: readonly unknown[] = ["wait-review", "merge"];

interface StoredRead {
  readonly runId: unknown;
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
  methods: ReadonlyMap<string, unknown>,
): string | undefined {
  const digest = record(event["payload"])?.["result"];
  if (event["type"] !== "effect.reported" || !isReportResultDigest(digest))
    return undefined;
  return storedMethods.includes(methods.get(effectKey(event)))
    ? digest
    : undefined;
}

function storedReads(effects: readonly Fields[]): readonly StoredRead[] {
  const methods = new Map<string, unknown>();
  const reads = new Map<string, StoredRead>();
  for (const event of effects) {
    const key = effectKey(event);
    if (event["type"] === "effect.requested" && !methods.has(key))
      methods.set(key, record(event["payload"])?.["method"]);
    const digest = storedDigest(event, methods);
    if (digest !== undefined && !reads.has(digest))
      reads.set(digest, { runId: event["runId"], digest });
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
  effects: readonly Fields[],
): Promise<ReportEffectResults> {
  const results: Record<string, ReportEffectResult> = {};
  for (const read of storedReads(effects))
    results[read.digest] = await storedResult(runtime, read);
  return results;
}
