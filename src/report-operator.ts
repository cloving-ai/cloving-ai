import type { Fields } from "./protocol.ts";
import {
  reportOperatorEffects,
  type ReportEffectResults,
  type ReportOperatorEffect,
} from "./report-effects.ts";
import {
  reportMetric,
  type ReportDatum,
  type ReportWindow,
} from "./report-statistics.ts";

export interface ReportOperatorInput {
  readonly effects: readonly Fields[] | null;
  readonly effectResults?: ReportEffectResults;
  readonly pulls: readonly ReportDatum[] | null;
  readonly labels: readonly ReportDatum[] | null;
}

export function reportOperatorMetrics(
  input: ReportOperatorInput,
  window: ReportWindow,
) {
  const merges = reportOperatorEffects(input, "merge");
  const labels = reportOperatorEffects(input, "label");
  return {
    merges: reportMetric({
      data:
        merges === null || input.pulls === null
          ? null
          : operatorMerges(input.pulls, {
              merges: merges.filter((effect) => effect.at < window.end),
            }),
      window,
      aggregation: "count",
    }),
    labelChanges: reportMetric({
      data:
        labels === null || input.labels === null
          ? null
          : input.labels.filter(
              (event) =>
                !labels.some(
                  (effect) =>
                    effect.at < window.end &&
                    effect.number === event.evidence["issue"] &&
                    Math.abs(effect.at - event.at) <= 120_000,
                ),
            ),
      window,
      aggregation: "count",
    }),
  };
}

function operatorMerges(
  pulls: readonly ReportDatum[],
  daemon: { readonly merges: readonly ReportOperatorEffect[] },
): ReportDatum[] {
  const unknown = daemon.merges.find((effect) => effect.number === null);
  return pulls.flatMap((pull) => {
    const matching = daemon.merges.filter(
      (effect) => effect.number === pull.evidence["pullRequest"],
    );
    if (matching.some((effect) => effect.reason === undefined)) return [];
    const reason = matching[0]?.reason ?? unknown?.reason;
    if (reason === undefined) return [pull];
    return [{ ...pull, value: null, evidence: { ...pull.evidence, reason } }];
  });
}
