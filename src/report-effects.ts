import { record, type Fields } from "./protocol.ts";
import type { ReportDatum } from "./report-statistics.ts";

interface EffectPair {
  readonly request: Fields;
  readonly report: Fields;
}

function payloadOf(event: Fields): Fields {
  return record(event["payload"]) ?? {};
}

function resultOf(value: unknown): Fields {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  const result = record(parsed);
  if (result === undefined) throw new Error("invalid-report-effect-result");
  return result;
}

function requestsOf(events: readonly Fields[]): Fields[] {
  const requests = new Map<string, Fields>();
  for (const event of events) {
    if (event["type"] !== "effect.requested") continue;
    const key = JSON.stringify([
      event["runId"],
      payloadOf(event)["operationId"],
    ]);
    if (!requests.has(key)) requests.set(key, event);
  }
  return [...requests.values()];
}

function pairsOf(events: readonly Fields[]): EffectPair[] {
  const requests = requestsOf(events);
  return events.flatMap((report) => {
    if (report["type"] !== "effect.reported") return [];
    const request = requests.find(
      (item) =>
        item["runId"] === report["runId"] &&
        payloadOf(item)["operationId"] === payloadOf(report)["operationId"],
    );
    if (request === undefined) throw new Error("missing-report-effect-request");
    return [{ request, report }];
  });
}

function fixRoundDatum(
  pair: EffectPair,
  requests: readonly Fields[],
): ReportDatum[] {
  const { request, report } = pair;
  const payload = payloadOf(report);
  if (
    payloadOf(request)["method"] !== "merge" ||
    payload["outcome"] !== "completed"
  )
    return [];
  const result = resultOf(payload["result"]);
  if (!mergedResult(result["merged"])) return [];
  const own = requests.filter((item) => item["runId"] === report["runId"]);
  const opened = own.find((item) => payloadOf(item)["method"] === "open-pr");
  const rounds =
    opened === undefined
      ? null
      : own.filter(
          (item) =>
            payloadOf(item)["method"] === "run-turn" &&
            Number(item["sequence"]) > Number(opened["sequence"]) &&
            Number(item["sequence"]) < Number(report["sequence"]),
        ).length;
  return [
    {
      at: Number(report["at"]),
      value: rounds,
      evidence: {
        runId: report["runId"],
        pullRequest:
          result["number"] ?? resultOf(payloadOf(request)["payload"])["number"],
        operationId: payload["operationId"],
        fixRounds: rounds,
      },
    },
  ];
}

export function reportFixRounds(
  events: readonly Fields[] | null,
): ReportDatum[] | null {
  if (events === null) return null;
  try {
    const requests = requestsOf(events);
    return pairsOf(events).flatMap((pair) => fixRoundDatum(pair, requests));
  } catch {
    return null;
  }
}

export function reportPhaseTimes(
  events: readonly Fields[] | null,
  method: string,
): ReportDatum[] | null {
  if (events === null) return null;
  try {
    return pairsOf(events).flatMap(({ request, report }) => {
      if (payloadOf(request)["method"] !== method) return [];
      const at = Number(report["at"]);
      const minutes = (at - Number(request["at"])) / 60_000;
      return [
        {
          at,
          value: Number.isFinite(minutes) && minutes >= 0 ? minutes : null,
          evidence: {
            runId: report["runId"],
            operationId: payloadOf(report)["operationId"],
          },
        },
      ];
    });
  } catch {
    return null;
  }
}

function mergedResult(value: unknown): boolean {
  return (
    value === true ||
    (typeof value === "string" && /^[a-f0-9]{40}$/i.test(value))
  );
}
