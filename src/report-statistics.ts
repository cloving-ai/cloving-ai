export interface ReportDatum {
  readonly at: number;
  readonly value: number | null;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface ReportWindow {
  readonly start: number;
  readonly end: number;
  readonly observedSince: number | null;
}

interface MetricInput {
  readonly data: readonly ReportDatum[] | null;
  readonly window: ReportWindow;
  readonly aggregation: "count" | "median";
}

export function reportMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return (
    (sorted[middle] ?? 0) / 2 +
    (sorted[Math.ceil(sorted.length / 2) - 1] ?? 0) / 2
  );
}

function selected(
  data: readonly ReportDatum[],
  window: Pick<ReportWindow, "start" | "end">,
): readonly ReportDatum[] {
  return data.filter(
    (datum) => datum.at >= window.start && datum.at < window.end,
  );
}

function aggregate(
  data: readonly ReportDatum[],
  aggregation: MetricInput["aggregation"],
): number | null {
  if (data.some((datum) => datum.value === null)) return null;
  const values = data.flatMap((datum) =>
    datum.value === null ? [] : [datum.value],
  );
  return aggregation === "count"
    ? values.reduce((sum, value) => sum + value, 0)
    : reportMedian(values);
}

function baseline(input: MetricInput) {
  const day = 86_400_000;
  const origin = input.window.observedSince;
  const samples: number[] = [];
  const evidence: Readonly<Record<string, unknown>>[] = [];
  for (let index = 1; index <= 7; index += 1) {
    const end = input.window.start - (index - 1) * day;
    const start = end - day;
    if (origin === null || origin > start || input.data === null) continue;
    const data = selected(input.data, { start, end });
    const value = aggregate(data, input.aggregation);
    if (value === null) continue;
    samples.push(value);
    evidence.push(...data.map((datum) => datum.evidence));
  }
  return { ...historySummary(samples), evidence };
}

function historySummary(samples: readonly number[]) {
  const median = reportMedian(samples);
  const deviation =
    median === null
      ? null
      : reportMedian(samples.map((value) => Math.abs(value - median)));
  if (samples.length < 5 || median === null || deviation === null)
    return { history: "short", days: samples.length, median: null, band: null };
  const band = { low: median - 3 * deviation, high: median + 3 * deviation };
  if (!Number.isFinite(band.low) || !Number.isFinite(band.high))
    return { history: "unavailable", days: samples.length, median, band: null };
  return { history: "available", days: samples.length, median, band };
}

export function reportMetric(input: MetricInput) {
  const data = selected(input.data ?? [], input.window);
  const value = input.data === null ? null : aggregate(data, input.aggregation);
  const comparisonValue =
    value !== null && input.aggregation === "count"
      ? (value * 86_400_000) / (input.window.end - input.window.start)
      : value;
  const history = baseline(input);
  const outside = outsideReportBand(comparisonValue, history.band);
  return {
    status: value === null ? "unavailable" : "available",
    value,
    comparisonValue,
    baseline: history,
    ...(outside ? { mark: "outside" } : {}),
    evidence: data.map((datum) => datum.evidence),
  };
}

export function outsideReportBand(
  value: number | null,
  band: { readonly low: number; readonly high: number } | null,
): boolean {
  return (
    value !== null && band !== null && (value < band.low || value > band.high)
  );
}
