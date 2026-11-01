import { record, type Fields } from "../protocol.ts";
import type { ReportDatum } from "../report-statistics.ts";
import { positiveInteger } from "./report-ci.ts";
import { rows, timestamp, type Reader } from "./report-github-reader.ts";

export async function readOperatorLabels(
  reader: Reader,
  since: string,
): Promise<ReportDatum[]> {
  const result: ReportDatum[] = [];
  const seen = new Set<number>();
  for (let page = 1; ; page += 1) {
    const events = rows(
      await reader.read(`issues/events?per_page=100&page=${String(page)}`),
    );
    for (const event of events) {
      const id = positiveInteger(event["id"]);
      if (seen.has(id)) throw new Error("response");
      seen.add(id);
      result.push(...labelDatum(event, since));
    }
    if (events.length < 100) return result;
  }
}

function labelDatum(event: Fields, since: string): ReportDatum[] {
  const id = positiveInteger(event["id"]);
  if (!["labeled", "unlabeled"].includes(String(event["event"]))) return [];
  const label = record(event["label"])?.["name"];
  if (typeof label !== "string") throw new Error("response");
  if (!label.startsWith("cloving:")) return [];
  const at = timestamp(event["created_at"]);
  if (at < Date.parse(since)) return [];
  const issue = positiveInteger(record(event["issue"])?.["number"]);
  return [
    {
      at,
      value: 1,
      evidence: { issue, eventId: id, event: event["event"], label },
    },
  ];
}
