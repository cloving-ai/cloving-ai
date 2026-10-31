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

function requestsOf(events: readonly Fields[]): Map<string, Fields> {
  const requests = new Map<string, Fields>();
  for (const event of events) {
    if (event["type"] !== "effect.requested") continue;
    const key = effectKey(event);
    if (!requests.has(key)) requests.set(key, event);
  }
  return requests;
}

function effectKey(event: Fields): string {
  return JSON.stringify([event["runId"], payloadOf(event)["operationId"]]);
}

function pairsOf(
  events: readonly Fields[],
  requests: ReadonlyMap<string, Fields>,
): EffectPair[] {
  return events.flatMap((report) => {
    if (report["type"] !== "effect.reported") return [];
    const request = requests.get(effectKey(report));
    if (request === undefined) throw new Error("missing-report-effect-request");
    return [{ request, report }];
  });
}

interface EffectHistory {
  readonly pairs: readonly EffectPair[];
  readonly runs: ReadonlyMap<string, readonly Fields[]>;
}

function historyOf(events: readonly Fields[] | null): EffectHistory | null {
  if (events === null) return null;
  try {
    const requests = requestsOf(events);
    const runs = new Map<string, Fields[]>();
    for (const request of requests.values()) {
      const runId = request["runId"];
      if (typeof runId !== "string") throw new Error("invalid-report-run-id");
      const own = runs.get(runId) ?? [];
      own.push(request);
      runs.set(runId, own);
    }
    return { pairs: pairsOf(events, requests), runs };
  } catch {
    return null;
  }
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
  const own = requests;
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

function fixRounds(history: EffectHistory | null): ReportDatum[] | null {
  if (history === null) return null;
  try {
    return history.pairs.flatMap((pair) => {
      const runId = pair.report["runId"];
      if (typeof runId !== "string") throw new Error("invalid-report-run-id");
      return fixRoundDatum(pair, history.runs.get(runId) ?? []);
    });
  } catch {
    return null;
  }
}

function phaseTimes(
  history: EffectHistory | null,
  method: string,
): ReportDatum[] | null {
  if (history === null) return null;
  return history.pairs.flatMap(({ request, report }) => {
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
}

export function reportFixRounds(events: readonly Fields[] | null) {
  return fixRounds(historyOf(events));
}

export function reportPhaseTimes(
  events: readonly Fields[] | null,
  method: string,
) {
  return phaseTimes(historyOf(events), method);
}

export function reportEffectData(events: readonly Fields[] | null) {
  const history = historyOf(events);
  return {
    fixRounds: fixRounds(history),
    workerTurn: phaseTimes(history, "run-turn"),
    codeReview: phaseTimes(history, "wait-review"),
    merge: phaseTimes(history, "merge"),
  };
}

function mergedResult(value: unknown): boolean {
  return (
    value === true ||
    (typeof value === "string" && /^[a-f0-9]{40}$/i.test(value))
  );
}
