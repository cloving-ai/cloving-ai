import { record, type Fields } from "../protocol.ts";
import type { ReportDatum } from "../report-statistics.ts";
import { rows, timestamp, type Reader } from "./report-github-reader.ts";

export function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("response");
  return value;
}

export async function mainRuns(reader: Reader, since: string) {
  const result: Fields[] = [];
  const seen = new Set<number>();
  for (let page = 1; ; page += 1) {
    const response = record(
      await reader.read(
        `actions/runs?branch=main&created=%3E%3D${encodeURIComponent(since)}&per_page=100&page=${String(page)}`,
      ),
    );
    if (Number(response?.["total_count"]) > 1000)
      throw new Error("response-truncated");
    const values = rows(response?.["workflow_runs"]);
    for (const run of values) {
      const id = positiveInteger(run["id"]);
      if (seen.has(id)) throw new Error("response");
      seen.add(id);
      if (run["name"] !== "CI" || run["head_branch"] !== "main") continue;
      timestamp(run["created_at"]);
      positiveInteger(run["run_attempt"]);
      result.push(run);
    }
    if (values.length < 100) return result;
  }
}

export async function firstPassData(
  reader: Reader,
  runs: readonly Fields[],
): Promise<ReportDatum[]> {
  const result: ReportDatum[] = [];
  for (const run of runs) {
    const first =
      run["run_attempt"] === 1
        ? run
        : record(
            await reader.read(`actions/runs/${String(run["id"])}/attempts/1`),
          );
    if (
      first === undefined ||
      first["id"] !== run["id"] ||
      first["run_attempt"] !== 1 ||
      first["head_sha"] !== run["head_sha"]
    )
      throw new Error("response");
    const conclusion = first["conclusion"];
    if (conclusion !== null && typeof conclusion !== "string")
      throw new Error("response");
    result.push({
      at: timestamp(run["created_at"]),
      value: conclusion === "success" ? 1 : 0,
      evidence: {
        runId: run["id"],
        commit: run["head_sha"],
        attempt: 1,
        conclusion,
      },
    });
  }
  return result;
}
