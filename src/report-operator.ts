import type { Fields } from "./protocol.ts";
import { reportOperatorEffects } from "./report-effects.ts";
import {
  reportMetric,
  type ReportDatum,
  type ReportWindow,
} from "./report-statistics.ts";

export interface ReportOperatorInput {
  readonly effects: readonly Fields[] | null;
  readonly pulls: readonly ReportDatum[] | null;
  readonly labels: readonly ReportDatum[] | null;
}

export function reportOperatorMetrics(
  input: ReportOperatorInput,
  window: ReportWindow,
) {
  const merges = reportOperatorEffects(input.effects, "merge");
  const labels = reportOperatorEffects(input.effects, "label");
  return {
    merges: reportMetric({
      data:
        merges === null || input.pulls === null
          ? null
          : input.pulls.filter(
              (pull) =>
                !merges.some(
                  (effect) =>
                    effect.at < window.end &&
                    effect.number === pull.evidence["pullRequest"],
                ),
            ),
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
