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

export type ReportEffectResult =
  { readonly body: string } | { readonly reason: string };

export type ReportEffectResults = Readonly<Record<string, ReportEffectResult>>;

type ReadResult =
  | { readonly kind: "read"; readonly result: Fields }
  | { readonly kind: "unread"; readonly reason: string };

export function isReportResultDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function parsedResult(value: unknown): ReadResult {
  try {
    return { kind: "read", result: resultOf(value) };
  } catch {
    return { kind: "unread", reason: "invalid-effect-result" };
  }
}

function storedResult(
  value: unknown,
  results: ReportEffectResults,
): ReadResult {
  if (!isReportResultDigest(value)) return parsedResult(value);
  const stored = results[value];
  if (stored === undefined)
    return { kind: "unread", reason: "effect-result-not-read" };
  if ("reason" in stored) return { kind: "unread", reason: stored.reason };
  return parsedResult(stored.body);
}

function reasonOf(read: ReadResult): Fields {
  return read.kind === "unread" ? { reason: read.reason } : {};
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

function requestedNumber(request: Fields): unknown {
  const read = parsedResult(payloadOf(request)["payload"]);
  return read.kind === "read" ? read.result["number"] : undefined;
}

function mergeRead(
  pair: EffectPair,
  results: ReportEffectResults,
): ReadResult | null {
  const payload = payloadOf(pair.report);
  if (
    payloadOf(pair.request)["method"] !== "merge" ||
    payload["outcome"] !== "completed"
  )
    return null;
  const read = storedResult(payload["result"], results);
  if (read.kind === "read" && !mergedResult(read.result["merged"])) return null;
  return read;
}

function roundsBefore(
  report: Fields,
  requests: readonly Fields[],
): number | null {
  const opened = requests.find(
    (item) => payloadOf(item)["method"] === "open-pr",
  );
  if (opened === undefined) return null;
  return requests.filter(
    (item) =>
      payloadOf(item)["method"] === "run-turn" &&
      Number(item["sequence"]) > Number(opened["sequence"]) &&
      Number(item["sequence"]) < Number(report["sequence"]),
  ).length;
}

function fixRoundDatum(
  pair: EffectPair,
  context: {
    readonly requests: readonly Fields[];
    readonly results: ReportEffectResults;
  },
): ReportDatum[] {
  const read = mergeRead(pair, context.results);
  if (read === null) return [];
  const { request, report } = pair;
  const rounds =
    read.kind === "read" ? roundsBefore(report, context.requests) : null;
  const number = read.kind === "read" ? read.result["number"] : undefined;
  return [
    {
      at: Number(report["at"]),
      value: rounds,
      evidence: {
        runId: report["runId"],
        pullRequest: number ?? requestedNumber(request),
        operationId: payloadOf(report)["operationId"],
        fixRounds: rounds,
        ...reasonOf(read),
      },
    },
  ];
}

function fixRounds(
  history: EffectHistory | null,
  results: ReportEffectResults,
): ReportDatum[] | null {
  if (history === null) return null;
  try {
    return history.pairs.flatMap((pair) => {
      const runId = pair.report["runId"];
      if (typeof runId !== "string") throw new Error("invalid-report-run-id");
      return fixRoundDatum(pair, {
        requests: history.runs.get(runId) ?? [],
        results,
      });
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

export function reportFixRounds(
  events: readonly Fields[] | null,
  results: ReportEffectResults = {},
) {
  return fixRounds(historyOf(events), results);
}

export function reportPhaseTimes(
  events: readonly Fields[] | null,
  method: string,
) {
  return phaseTimes(historyOf(events), method);
}

export function reportEffectData(
  events: readonly Fields[] | null,
  results: ReportEffectResults = {},
) {
  const history = historyOf(events);
  return {
    fixRounds: fixRounds(history, results),
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

export function reportReviewScores(
  events: readonly Fields[] | null,
  results: ReportEffectResults = {},
) {
  const history = historyOf(events);
  if (history === null) return null;
  const rounds: Record<string, ReportDatum[]> = { round1: [] };
  for (const { request, report } of history.pairs) {
    if (payloadOf(request)["method"] !== "wait-review") continue;
    const own = history.runs.get(String(request["runId"])) ?? [];
    const round = own.filter(
      (event) =>
        payloadOf(event)["method"] === "wait-review" &&
        Number(event["sequence"]) <= Number(request["sequence"]),
    ).length;
    const key = `round${String(round)}`;
    const data = rounds[key] ?? [];
    const { score, reason } = reviewScoreOf(report, results);
    data.push({
      at: Number(report["at"]),
      value: score,
      evidence: {
        runId: report["runId"],
        operationId: payloadOf(report)["operationId"],
        sequence: report["sequence"],
        round,
        score,
        ...reason,
      },
    });
    rounds[key] = data;
  }
  return rounds;
}

function reviewScoreOf(
  report: Fields,
  results: ReportEffectResults,
): { readonly score: number | null; readonly reason: Fields } {
  const payload = payloadOf(report);
  if (payload["outcome"] !== "completed") return { score: null, reason: {} };
  const read = storedResult(payload["result"], results);
  if (read.kind === "unread") return { score: null, reason: reasonOf(read) };
  const value = read.result["score"];
  const valid =
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 5;
  return { score: valid ? value : null, reason: {} };
}

export interface ReportOperatorEffect {
  readonly number: number | null;
  readonly at: number;
  readonly reason?: string;
}

const noResult: ReadResult = { kind: "read", result: {} };

function pullNumberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : null;
}

function operatorEffect(
  pair: EffectPair,
  context: {
    readonly method: "merge" | "label";
    readonly results: ReportEffectResults;
  },
): ReportOperatorEffect[] {
  const { request, report } = pair;
  if (payloadOf(request)["method"] !== context.method) return [];
  const read =
    context.method === "merge" ? mergeRead(pair, context.results) : noResult;
  if (read === null) return [];
  const at = Number(report["at"]);
  if (!Number.isFinite(at)) throw new Error("invalid-report-effect");
  const given = read.kind === "read" ? read.result["number"] : undefined;
  const number = pullNumberOf(given ?? requestedNumber(request));
  if (read.kind === "unread") return [{ number, at, reason: read.reason }];
  if (number === null) throw new Error("invalid-report-effect");
  return [{ number, at }];
}

export function reportOperatorEffects(
  source: {
    readonly effects: readonly Fields[] | null;
    readonly effectResults?: ReportEffectResults;
  },
  method: "merge" | "label",
): ReportOperatorEffect[] | null {
  const history = historyOf(source.effects);
  if (history === null) return null;
  const results = source.effectResults ?? {};
  try {
    return history.pairs.flatMap((pair) =>
      operatorEffect(pair, { method, results }),
    );
  } catch {
    return null;
  }
}
